import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { CONTROLLER_EXIT, LAUNCHER_FILE, Launcher, lockRoot, Supervisor, SUPERVISOR_EXIT, type SupervisorEvent, type SupervisorOptions } from "./index.js";
import { Clock, pointerSwitcher, sha256 } from "./start-fixture.js";

/**
 * The launcher's process supervisor (card K02a) against fake controllers: real child processes that confirm, hang, crash, exit at once or ignore SIGTERM. Release directories are fixtures; no real controller, no
 * database and no deployment is involved.
 */
const SECRET = "sk-test-SECRET-sentinel-0123456789";
const DIST = pathToFileURL(join(import.meta.dirname, "launcher.js")).href;
const PROTOCOL = { min: 1, max: 1 };

const controllerSource = (behavior: string): string => `
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
const id = process.env.NIMBLENEWT_RUNNING_RELEASE;
const mod = await import(process.env.NN_DIST);
const { PointerSwitcher } = await import(process.env.NN_ACTIVATION);
const launcher = new mod.Launcher({ root: process.env.NN_ROOT, switcher: new PointerSwitcher(process.env.NN_ROOT) });
const behavior = ${JSON.stringify(behavior)};
appendFileSync(process.env.NN_PIDS + "/" + id + ".pids", process.pid + "\\n");
const confirm = async () => { try { await launcher.confirm(id); } catch {} };
const keep = () => setInterval(() => {}, 1000);
appendFileSync(process.env.NN_PIDS + "/" + id + ".env", (process.env.NIMBLENEWT_HEARTBEAT_FILE ?? "none") + "\\n");
const hb = async () => { const { HeartbeatWriter } = await import(process.env.NN_HB); return HeartbeatWriter.start({ file: process.env.NIMBLENEWT_HEARTBEAT_FILE, token: process.env.NIMBLENEWT_HEARTBEAT_TOKEN, intervalMs: Number(process.env.NIMBLENEWT_HEARTBEAT_INTERVAL_MS) }); };
const busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };
if (behavior === "exit0") process.exit(0);
if (behavior === "secret") console.log(process.env.NN_SECRET);
if (behavior === "orphan-crash") {
  await confirm();
  const g = spawn("sleep", ["300"], { stdio: "ignore" });
  appendFileSync(process.env.NN_PIDS + "/" + id + ".gpids", g.pid + "\\n");
  setTimeout(() => process.exit(1), 150);
  keep();
} else if (behavior === "stubborn-kid") {
  // The leader obeys SIGTERM; its child ignores it and records itself only once its handler is in place.
  spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});require('node:fs').appendFileSync(process.argv[1],process.pid+String.fromCharCode(10));setInterval(()=>{},1000)", process.env.NN_PIDS + "/" + id + ".gpids"], { stdio: "ignore" });
  keep();
} else if (behavior === "stop-on-purpose") { await confirm(); setTimeout(() => process.exit(0), 100); keep(); }
else if (behavior === "restart-once") {
  const { existsSync, writeFileSync } = await import("node:fs");
  const mark = process.env.NN_PIDS + "/" + id + ".restarted";
  await confirm();
  if (!existsSync(mark)) { writeFileSync(mark, "1"); setTimeout(() => process.exit(${CONTROLLER_EXIT.restart}), 100); }
  keep();
} else if (behavior === "stubborn") {
  process.on("SIGTERM", () => {});
  const g = spawn("sleep", ["300"], { stdio: "ignore" });
  appendFileSync(process.env.NN_PIDS + "/" + id + ".gpids", g.pid + "\\n");
  keep();
} else if (behavior === "hang") keep();
else if (behavior === "beat") { await confirm(); await hb(); keep(); }
else if (behavior === "slow-beat") { await confirm(); await hb(); setInterval(() => busy(2500), 3000); keep(); }
else if (behavior === "hang-always") { await confirm(); await hb(); setTimeout(() => { for (;;) {} }, 1000); keep(); }
else if (behavior === "hang-once") {
  // A controller with its own SIGTERM handler (exit 0, as a clean stop would): while its loop is blocked the handler cannot run; once the block ends it does.
  const { existsSync, writeFileSync } = await import("node:fs");
  const mark = process.env.NN_PIDS + "/" + id + ".hung";
  process.on("SIGTERM", () => process.exit(0));
  await confirm(); await hb();
  if (!existsSync(mark)) { writeFileSync(mark, "1"); setTimeout(() => busy(12000), 1000); }
  keep();
}
else if (behavior === "slow-confirm") { setTimeout(confirm, 800); keep(); }
else if (behavior.startsWith("crash-after:")) { await confirm(); setTimeout(() => process.exit(1), Number(behavior.slice(12))); keep(); }
else { await confirm(); keep(); }
`;

interface World {
  readonly root: string;
  readonly pids: string;
  readonly clock: Clock;
  readonly launcher: Launcher;
  readonly events: SupervisorEvent[];
  readonly lines: string[];
  readonly delays: number[];
  /** Makes a release whose controller does `behavior` and announces it (the controller's side of an activation). */
  release(tag: string, behavior: string): Promise<{ id: string; digest: string }>;
  /** Makes the release the last known good, as a controller that started and confirmed would. */
  good(r: { id: string; digest: string }): Promise<void>;
  point(r: { id: string }): Promise<void>;
  state(): any;
  start(extra?: Partial<SupervisorOptions>): { done: Promise<{ code: number; reason: string }>; stop(): void };
  waitFor(what: string, cond: () => boolean, ms?: number): Promise<void>;
  pidsOf(r: { id: string }, ext?: string): number[];
}

/**
 * Windows has no process groups and no SIGTERM a process can catch or ignore: the supervisor ends the child's whole tree at once with `taskkill /T /F` and has nothing to drain after it (supervisor.ts, the stop
 * ladder and `leftovers` are POSIX only). The tests of the group ladder (a SIGTERM ignored, members left after the leader, a crashed leader's group) therefore run on POSIX only.
 */
const POSIX_GROUPS = process.platform === "win32" && "Windows has no process groups or catchable SIGTERM; the supervisor ends the tree with taskkill /T /F (supervisor.ts)";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function world(body: (w: World) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "nn-k02a-"));
  const pids = join(root, "pids");
  mkdirSync(pids);
  const clock = new Clock();
  const sw = pointerSwitcher(root);
  const launcher = new Launcher({ root, switcher: sw, now: clock.now, monotonic: clock.mono, workers: PROTOCOL });
  const events: SupervisorEvent[] = [];
  const lines: string[] = [];
  const delays: number[] = [];
  const running: ChildProcess[] = [];
  const stops: (() => void)[] = [];
  const w: World = {
    root, pids, clock, launcher, events, lines, delays,
    async release(tag, behavior) {
      const id = `rcn-${sha256(`k02a-${tag}`).slice(0, 24)}`;
      const dir = join(root, "releases", id);
      mkdirSync(dir, { recursive: true });
      const body = controllerSource(behavior);
      writeFileSync(join(dir, "controller.js"), body);
      const manifest = JSON.stringify({ candidateId: id, sourceCommit: "a".repeat(40), files: { "controller.js": { sha256: sha256(body), size: Buffer.byteLength(body) } } });
      writeFileSync(join(dir, "MANIFEST.json"), manifest);
      const r = { id, digest: sha256(manifest) };
      await launcher.expect({ ...r, protocol: PROTOCOL });
      return r;
    },
    async good(r) { await sw.write(r.id); assert.equal((await launcher.prepare()).action, "run"); assert.equal(await launcher.confirm(r.id), true); },
    point: (r) => sw.write(r.id),
    state: () => JSON.parse(readFileSync(join(root, LAUNCHER_FILE), "utf8")),
    start(extra = {}) {
      const ac = new AbortController();
      const sup = new Supervisor({
        launcher, signal: ac.signal, pollMs: 10, graceMs: 2000, stdio: "ignore",
        child: (release) => ({ command: process.execPath, args: [join(release.dir, "controller.js")], env: { ...process.env, NN_ROOT: root, NN_DIST: DIST, NN_ACTIVATION: pathToFileURL(join(import.meta.dirname, "activation.js")).href, NN_PIDS: pids, NN_SECRET: SECRET, NN_HB: pathToFileURL(join(import.meta.dirname, "heartbeat.js")).href } }),
        log: (l) => lines.push(l), onEvent: (e) => events.push(e),
        sleep: async (ms) => { delays.push(ms); },
        ...extra,
      });
      const done = sup.run();
      stops.push(() => ac.abort());
      return { done, stop: () => ac.abort() };
    },
    async waitFor(what, cond, ms = 20_000) {
      const end = Date.now() + ms;
      while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}; events: ${JSON.stringify(events)}`); await new Promise((r) => setTimeout(r, 15)); }
    },
    pidsOf(r, ext = "pids") { const f = join(pids, `${r.id}.${ext}`); return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(Number) : []; },
  };
  try { await body(w); } finally {
    for (const s of stops) s();
    for (const f of readdirSync(pids)) for (const p of readFileSync(join(pids, f), "utf8").split("\n").filter(Boolean).map(Number)) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    for (const c of running) c.kill("SIGKILL");
    // On Windows a process killed a moment ago can still hold its working directory (a release folder) for a little while.
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
const kinds = (w: World): string[] => w.events.map((e) => (e.kind === "started" || e.kind === "exited" ? `${e.kind}:${e.releaseId}` : e.kind));

test("a controller that confirms keeps running and is the last known good; stopping the launcher stops it and exits 0; no secret reaches the launcher's log or record (K02a)", async () => {
  await world(async (w) => {
    const a = await w.release("a", "secret");
    await w.point(a);
    const run = w.start();
    await w.waitFor("confirmation", () => w.state().known?.id === a.id);
    const [pid] = w.pidsOf(a);
    assert.ok(pid !== undefined && alive(pid), "the controller runs");
    assert.equal(w.events.filter((e) => e.kind === "started").length, 1);
    run.stop();
    const result = await run.done;
    assert.deepEqual(result, { code: SUPERVISOR_EXIT.stopped, reason: "stopped" });
    await w.waitFor("the child to be gone", () => !alive(pid));
    assert.equal(w.events.filter((e) => e.kind === "started").length, 1, "not started again after the stop");
    const everything = JSON.stringify([w.lines, w.events, readFileSync(join(w.root, LAUNCHER_FILE), "utf8")]);
    assert.ok(!everything.includes(SECRET) && !everything.includes("sk-test"), "no secret in logs, events or the launcher's record");
    assert.ok(w.lines.some((l) => l.includes(a.id)), "release IDs are logged");
  });
});

test("a start the controller never confirms is stopped when the startup window ends, the pointer falls back to the last known good, and the failed release is never run again (K02a, K02e)", async () => {
  await world(async (w) => {
    const g = await w.release("good", "confirm");
    await w.good(g);
    await w.launcher.setWindow(10);
    const b = await w.release("bad", "hang");
    await w.point(b);
    const bystander = spawn("sleep", ["300"], { stdio: "ignore" });
    try {
      const run = w.start();
      await w.waitFor("the hung start to begin", () => w.pidsOf(b).length === 1);
      const [hung] = w.pidsOf(b);
      assert.ok(alive(hung!));
      w.clock.advance(11);
      await w.waitFor("the fall-back to start", () => w.events.some((e) => e.kind === "started" && e.releaseId === g.id));
      await w.waitFor("the hung child to be gone", () => !alive(hung!));
      assert.deepEqual(kinds(w).filter((k) => k !== "waiting"), [`started:${b.id}`, "judged", "stopping", `exited:${b.id}`, `started:${g.id}`]);
      assert.equal((w.events.find((e) => e.kind === "started" && e.releaseId === g.id) as { fellBackFrom?: string }).fellBackFrom, b.id);
      assert.ok(!w.events.some((e) => e.kind === "killed"), "SIGTERM was enough");
      assert.equal(w.state().failed.some((f: any) => f.id === b.id), true);
      assert.equal(w.state().known.id, g.id);
      assert.equal(await pointerSwitcher(w.root).read(), g.id, "the pointer is back on the last known good");
      assert.equal(w.state().notices.some((n: any) => n.kind === "fell_back" && n.release === b.id), true, "the owner's notice is in the launcher's file");
      assert.ok(alive(bystander.pid!), "no other process was touched");
      run.stop();
      assert.equal((await run.done).code, 0);
      assert.equal(w.pidsOf(b).length, 1, "the failed release was started once");
    } finally { bystander.kill("SIGKILL"); }
  });
});

test("a controller that ignores SIGTERM is killed after the grace, with its whole process group, and nothing else (K02a)", { skip: POSIX_GROUPS }, async () => {
  await world(async (w) => {
    const g = await w.release("good", "confirm");
    await w.good(g);
    await w.launcher.setWindow(10);
    const b = await w.release("stubborn", "stubborn");
    await w.point(b);
    const bystander = spawn("sleep", ["300"], { stdio: "ignore" });
    try {
      const run = w.start({ graceMs: 300 });
      await w.waitFor("the stubborn controller and its child", () => w.pidsOf(b).length === 1 && w.pidsOf(b, "gpids").length === 1);
      const [pid] = w.pidsOf(b);
      const [grandchild] = w.pidsOf(b, "gpids");
      w.clock.advance(11);
      await w.waitFor("the kill", () => w.events.some((e) => e.kind === "killed"));
      await w.waitFor("both processes gone", () => !alive(pid!) && !alive(grandchild!));
      await w.waitFor("the fall-back", () => w.events.some((e) => e.kind === "started" && e.releaseId === g.id));
      assert.ok(alive(bystander.pid!), "a process the launcher did not start is untouched");
      run.stop();
      await run.done;
    } finally { bystander.kill("SIGKILL"); }
  });
});

test("a controller that exits at once, or cannot be started, is judged failed at the next decision and falls back; a first release with nothing to fall back to blocks (exit 2) instead of spinning (K02a)", async () => {
  await world(async (w) => {
    const g = await w.release("good", "confirm");
    await w.good(g);
    const b = await w.release("quick", "exit0");
    await w.point(b);
    const run = w.start();
    await w.waitFor("the fall-back", () => w.events.some((e) => e.kind === "started" && e.releaseId === g.id));
    assert.deepEqual(kinds(w).filter((k) => k !== "waiting"), [`started:${b.id}`, `exited:${b.id}`, `started:${g.id}`]);
    assert.equal(w.state().failed.some((f: any) => f.id === b.id), true);
    assert.equal(await pointerSwitcher(w.root).read(), g.id);
    run.stop();
    await run.done;
  });
  await world(async (w) => {
    const g = await w.release("good", "confirm");
    await w.good(g);
    const b = await w.release("missing", "confirm");
    await w.point(b);
    const run = w.start({ child: (r) => ({ command: r.releaseId === b.id ? join(w.root, "no-such-program") : process.execPath, args: [join(r.dir, "controller.js")], env: { ...process.env, NN_ROOT: w.root, NN_DIST: DIST, NN_ACTIVATION: pathToFileURL(join(import.meta.dirname, "activation.js")).href, NN_PIDS: w.pids } }) });
    await w.waitFor("the fall-back", () => w.events.some((e) => e.kind === "started" && e.releaseId === g.id));
    assert.equal(w.events.find((e) => e.kind === "exited" && e.releaseId === b.id) !== undefined && (w.events.find((e) => e.kind === "exited" && e.releaseId === b.id) as { spawnFailed: boolean }).spawnFailed, true);
    run.stop();
    await run.done;
  });
  await world(async (w) => {
    const only = await w.release("only", "exit0");
    await w.point(only);
    const result = await w.start().done;
    assert.equal(result.code, SUPERVISOR_EXIT.blocked);
    assert.equal(w.events.filter((e) => e.kind === "started").length, 1, "started once, then blocked");
    assert.ok(w.delays.length <= 1, "one short wait at most, then the block ends it: no restart loop");
    assert.equal(w.state().failed.some((f: any) => f.id === only.id), true);
  });
});

test("a last known good that crashes at every start is restarted with a doubling delay, never quarantined, and the launcher gives up with exit 4 instead of spinning (K02a, K02d)", async () => {
  await world(async (w) => {
    const g = await w.release("loop", "crash-after:50");
    await w.good(g);
    const result = await w.start({ backoff: { initialMs: 1000, maxMs: 5000, stableMs: 60_000, giveUpAfter: 6 } }).done;
    assert.equal(result.code, SUPERVISOR_EXIT.crashLoop);
    assert.deepEqual(w.delays, [1000, 2000, 4000, 5000, 5000], "doubling, then capped");
    assert.equal(w.events.filter((e) => e.kind === "started").length, 6);
    const s = w.state();
    assert.deepEqual(s.failed, [], "the last known good is never quarantined");
    const told = (s.notices ?? []).filter((n: any) => n.kind === "failed_start" && n.release === g.id);
    assert.equal(told.length, 1, "the owner's notice of the crash loop is written");
    assert.equal(told[0].fallback, false, "nothing else is running: Urgent");
    assert.match(told[0].reason, /gave up/);
    assert.equal(s.known.id, g.id);
    assert.equal(await pointerSwitcher(w.root).read(), g.id);
  });
});

test("a run that lasts the stable time resets the restart delay (K02a)", async () => {
  await world(async (w) => {
    const g = await w.release("steady", "crash-after:500");
    await w.good(g);
    let n = 0;
    const run = w.start({ backoff: { initialMs: 1000, maxMs: 5000, stableMs: 300, giveUpAfter: 3 }, onEvent: (e) => { w.events.push(e); if (e.kind === "started") n += 1; } });
    await w.waitFor("five starts", () => n >= 5, 30_000);
    run.stop();
    await run.done;
    assert.deepEqual(w.delays, [], "every run was long enough: no delay, no give-up");
  });
});

test("a wall clock set forward while a release starts does not fail it; a start that stays unconfirmed on the monotonic clock does (K02a, K02e)", async () => {
  await world(async (w) => {
    const g = await w.release("good", "confirm");
    await w.good(g);
    await w.launcher.setWindow(10);
    const slow = await w.release("slow", "slow-confirm");
    await w.point(slow);
    const run = w.start();
    await w.waitFor("the slow start", () => w.pidsOf(slow).length === 1);
    await new Promise((r) => setTimeout(r, 100));
    w.clock.jump(86_400);
    await w.waitFor("its own confirmation", () => w.state().known?.id === slow.id);
    assert.equal(w.state().failed.length, 0, "a day forward on the wall clock failed nothing");
    assert.equal(w.events.filter((e) => e.kind === "started").length, 1);
    run.stop();
    await run.done;
  });
});

test("nothing is started when no release is active (exit 3), when the pointer names an unannounced release, or when the launcher's record is damaged (exit 2); the database is never needed (K02a)", async () => {
  await world(async (w) => {
    assert.equal((await w.start().done).code, SUPERVISOR_EXIT.noRelease);
    assert.equal(w.events.some((e) => e.kind === "started"), false);
  });
  await world(async (w) => {
    await pointerSwitcher(w.root).write("rcn-aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal((await w.start().done).code, SUPERVISOR_EXIT.blocked);
    assert.equal(w.events.some((e) => e.kind === "started"), false);
  });
  await world(async (w) => {
    const a = await w.release("a", "confirm");
    await w.point(a);
    writeFileSync(join(w.root, LAUNCHER_FILE), "{ not json");
    const r = await w.start().done;
    assert.equal(r.code, SUPERVISOR_EXIT.blocked);
    assert.match(r.reason, /will not guess/);
    assert.equal(w.events.some((e) => e.kind === "started"), false);
  });
});

test("stopping the launcher during the startup window stops the child and does not restart it (K02a)", async () => {
  await world(async (w) => {
    const b = await w.release("hang", "hang");
    await w.point(b);
    const run = w.start();
    await w.waitFor("the start", () => w.pidsOf(b).length === 1);
    const [pid] = w.pidsOf(b);
    run.stop();
    assert.equal((await run.done).code, 0);
    await w.waitFor("the child gone", () => !alive(pid!));
    assert.equal(w.pidsOf(b).length, 1);
    assert.equal(w.state().failed.length, 0, "a shutdown is not a failed start");
    assert.equal(w.state().attempt, undefined, "the interrupted start is closed, not left open for the next launch to count as failed");
    // The next launch (after a reboot, say) runs it again with a full window. With the start left open it would be quarantined and, with nothing to fall back to, the installation blocked for good.
    const again = w.start();
    await w.waitFor("the second start", () => w.pidsOf(b).length === 2);
    assert.equal(w.events.filter((e) => e.kind === "ended" && e.code === SUPERVISOR_EXIT.blocked).length, 0);
    again.stop();
    assert.equal((await again.done).code, 0);
  });
});

test("a controller that exits 0 after its start was confirmed stopped on purpose: the launcher ends 0 and starts nothing; exit 75 is a restart request (K02a)", async () => {
  await world(async (w) => {
    const a = await w.release("purpose", "stop-on-purpose");
    await w.good(a);
    const result = await w.start().done;
    assert.equal(result.code, SUPERVISOR_EXIT.stopped);
    assert.match(result.reason, /on purpose/);
    assert.equal(w.events.filter((e) => e.kind === "started").length, 1, "not started again");
    assert.deepEqual(w.delays, []);
  });
  await world(async (w) => {
    const a = await w.release("restart", "restart-once");
    await w.good(a);
    const run = w.start();
    await w.waitFor("the restart", () => w.events.filter((e) => e.kind === "started").length === 2);
    assert.ok(w.lines.some((l) => l.includes("asked to be restarted")));
    assert.equal(w.state().failed.length, 0);
    run.stop();
    assert.equal((await run.done).code, 0);
  });
});

test("what a controller that crashed left running in its process group is stopped before the next start (K02a)", { skip: POSIX_GROUPS }, async () => {
  await world(async (w) => {
    const g = await w.release("orphans", "orphan-crash");
    await w.good(g);
    let grandchildAliveAtRestart: boolean | undefined;
    const run = w.start({ graceMs: 1000, onEvent: (e) => {
      w.events.push(e);
      if (e.kind === "started" && w.events.filter((x) => x.kind === "started").length === 2) { const [gc] = w.pidsOf(g, "gpids"); grandchildAliveAtRestart = gc !== undefined && alive(gc); }
    } });
    await w.waitFor("the restart", () => w.events.filter((e) => e.kind === "started").length >= 2);
    assert.equal(grandchildAliveAtRestart, false, "the crashed controller's child was gone before the next start");
    assert.ok(w.events.some((e) => e.kind === "leftovers"));
    run.stop();
    await run.done;
  });
});

test("members of the group that ignore SIGTERM after the leader obeyed it are killed after the grace; a group that has emptied is never signalled again (K02a)", { skip: POSIX_GROUPS }, async () => {
  await world(async (w) => {
    const g = await w.release("good", "confirm");
    await w.good(g);
    await w.launcher.setWindow(10);
    const b = await w.release("kid", "stubborn-kid");
    await w.point(b);
    const run = w.start({ graceMs: 400 });
    await w.waitFor("the stubborn child", () => w.pidsOf(b, "gpids").length === 1);
    const [kid] = w.pidsOf(b, "gpids");
    w.clock.advance(11);
    await w.waitFor("the fall-back", () => w.events.some((e) => e.kind === "started" && e.releaseId === g.id));
    assert.equal(alive(kid!), false, "the child that ignored SIGTERM was killed with the group");
    assert.ok(w.events.some((e) => e.kind === "killed"));
    run.stop();
    await run.done;
  });
  await world(async (w) => {
    const g = await w.release("good", "confirm");
    await w.good(g);
    await w.launcher.setWindow(10);
    const b = await w.release("hang", "hang");
    await w.point(b);
    const real = process.kill;
    const calls: [number, string | number | undefined][] = [];
    process.kill = ((pid: number, sig?: string | number) => { calls.push([pid, sig]); return real.call(process, pid, sig); }) as typeof process.kill;
    try {
      const run = w.start({ graceMs: 2000 });
      await w.waitFor("the hung start", () => w.pidsOf(b).length === 1);
      const [hung] = w.pidsOf(b);
      w.clock.advance(11);
      await w.waitFor("the fall-back", () => w.events.some((e) => e.kind === "started" && e.releaseId === g.id));
      const sent = calls.filter(([p, sig]) => p === -hung! && sig !== 0).map(([, sig]) => sig);
      assert.deepEqual(sent, ["SIGTERM"], "the leader obeyed and left no members: no SIGKILL to a group number that may since belong to someone else");
      assert.ok(!calls.some(([p]) => p >= -1 && p <= 1), "never pid 0, 1 or -1");
      run.stop();
      await run.done;
    } finally { process.kill = real; }
  });
});

test("one launcher per release root: a second one exits 5 and starts nothing while the first runs; the lock is free again when the first ends; a stale socket file is replaced (K02a)", { timeout: 60_000 }, async () => {
  await world(async (w) => {
    const a = await w.release("a", "confirm");
    await w.good(a);
    const first = w.start({ root: w.root });
    await w.waitFor("the first controller", () => w.pidsOf(a).length === 1);
    const second = await w.start({ root: w.root }).done;
    assert.equal(second.code, SUPERVISOR_EXIT.locked);
    assert.equal(w.pidsOf(a).length, 1, "the second launcher started nothing");
    first.stop();
    assert.equal((await first.done).code, 0);
    const third = w.start({ root: w.root });
    await w.waitFor("the third launcher's controller", () => w.pidsOf(a).length === 2);
    third.stop();
    assert.equal((await third.done).code, 0);
  });
  // The socket-file lock (macOS and other systems without abstract sockets), exercised on this system. Windows takes a named pipe whatever `abstract` says (lockRoot), and a plain file path cannot be
  // listened on there, so this part is for POSIX systems.
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "nn-k02a-lock-"));
  try {
    const one = await lockRoot(root, { abstract: false });
    assert.ok(one !== undefined);
    assert.equal(await lockRoot(root, { abstract: false }), undefined, "held while the first listens");
    await one.close();
    // A holder that was killed leaves its socket file behind; nobody answers on it, so it is replaced.
    const holder = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(join(root, ".launcher.sock"))}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((r) => holder.stdout!.once("data", () => r()));
    assert.equal(await lockRoot(root, { abstract: false }), undefined, "a live holder in another process");
    holder.kill("SIGKILL");
    await new Promise((r) => holder.once("exit", r));
    assert.ok(existsSync(join(root, ".launcher.sock")), "the killed holder left its file");
    const two = await lockRoot(root, { abstract: false });
    assert.ok(two !== undefined, "a stale file is replaced");
    await two.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** The liveness tests run the heartbeat on a clock five times faster than real time: the 30 s minimum threshold is 6 s of real time, the writer still beats every real second. */
const FAST = { monotonic: (): number => performance.now() * 5, pollMs: 50, staleAfterMs: 30_000, intervalMs: 1000 } as const;
const runFiles = (w: World): string[] => { try { return readdirSync(join(w.root, "run")).sort(); } catch { return []; } };

test("a confirmed controller that beats and then blocks its event loop is found hung, stopped and started again; the owner is told; nothing is quarantined; a SIGTERM handler's exit 0 is not a stop on purpose (K02 heartbeat)", async () => {
  await world(async (w) => {
    const a = await w.release("hang-once", "hang-once");
    await w.point(a);
    const run = w.start({ graceMs: 12_000, heartbeat: FAST });
    await w.waitFor("the restart after the hang", () => w.events.filter((e) => e.kind === "started").length === 2 && w.pidsOf(a).length === 2, 60_000);
    const [first, second] = w.pidsOf(a);
    await w.waitFor("the hung child to be gone", () => !alive(first!));
    assert.ok(alive(second!), "the same release runs again");
    assert.deepEqual(kinds(w).filter((k) => k !== "judged"), [`started:${a.id}`, "hung", "stopping", `exited:${a.id}`, "waiting", `started:${a.id}`], JSON.stringify(w.events));
    const hung = w.events.find((e) => e.kind === "hung") as { quietMs: number; thresholdMs: number };
    assert.equal(hung.thresholdMs, 30_000);
    assert.ok(hung.quietMs >= 30_000);
    assert.equal((w.events.find((e) => e.kind === "stopping") as { why: string }).why, "hung");
    // On POSIX the stop is SIGTERM, which the handler takes once the block ends; Windows has no SIGTERM a process can catch, and taskkill /F ends it with code 1. Either way the exit is no stop on purpose.
    if (process.platform !== "win32") assert.equal((w.events.find((e) => e.kind === "exited") as { code: number | null }).code, 0, "the handler ran once the block ended and exited 0");
    assert.deepEqual(w.events.find((e) => e.kind === "waiting"), { kind: "waiting", ms: 1000, failures: 1 }, `counted as a short run: ${JSON.stringify(w.events)}`);
    const st = w.state();
    assert.equal(st.known.id, a.id, "still the last known good");
    assert.deepEqual(st.failed, [], "never quarantined");
    assert.ok(st.notices.some((n: any) => n.kind === "failed_start" && n.release === a.id && n.fallback === true && /stopped responding/.test(n.reason)), "the owner's notice");
    assert.ok(w.lines.some((l) => /is hung: no sign of life/.test(l)));
    // each start had its own private file under <root>/run; the hung one's is gone
    const envLines = (): string[] => { try { return readFileSync(join(w.pids, `${a.id}.env`), "utf8").split("\n").filter(Boolean); } catch { return []; } };
    await w.waitFor("the second start's environment", () => envLines().length === 2);
    const files = envLines();
    assert.notEqual(files[0], files[1], "a new file and token per start");
    for (const f of files) assert.ok(f.startsWith(join(w.root, "run", "heartbeat-")), f);
    // The writer makes each beat as `<file>.<pid>.tmp` and renames it over the record (heartbeat.ts), so a look at the folder can catch that file between the two: only the records count here.
    const records = (): string[] => runFiles(w).filter((f) => !f.endsWith(".tmp"));
    await w.waitFor("the new start's first beat", () => records().length === 1);
    assert.deepEqual(records(), [files[1]!.slice(join(w.root, "run").length + 1)], JSON.stringify({ files, run: runFiles(w) }));
    run.stop();
    assert.equal((await run.done).code, SUPERVISOR_EXIT.stopped);
    assert.deepEqual(runFiles(w), [], "removed when the child is gone");
  });
});

test("a controller that beats normally, one that beats slowly under load, and one that never beats (an older release) are never stopped (K02 heartbeat)", async () => {
  const one = (tag: string, behavior: string, check: (w: World) => void) => world(async (w) => {
    const a = await w.release(tag, behavior);
    await w.point(a);
    const run = w.start({ heartbeat: FAST });
    await w.waitFor("the confirmation", () => w.state().known?.id === a.id);
    // 10 s of real time is 50 s on the heartbeat's clock: well past the 30 s threshold
    await new Promise((r) => setTimeout(r, 10_000));
    assert.deepEqual(kinds(w), [`started:${a.id}`], `${tag}: nothing but the start`);
    assert.ok(alive(w.pidsOf(a)[0]!));
    check(w);
    run.stop();
    assert.equal((await run.done).code, SUPERVISOR_EXIT.stopped);
    assert.deepEqual(runFiles(w), []);
  });
  await Promise.all([
    one("beat", "beat", (w) => assert.equal(runFiles(w).length, 1, "it beats")),
    one("slow", "slow-beat", (w) => assert.equal(runFiles(w).length, 1, "it beats")),
    one("never", "confirm", (w) => assert.deepEqual(runFiles(w), [], "no beat: unsupported, left alone")),
  ]);
});

test("a controller that always hangs, or (with firstBeatMs) never beats, ends in the crash-loop exit 4 through the backoff; never quarantined; the launcher's own heartbeat variables replace inherited ones; heartbeat off sets none (K02 heartbeat)", async () => {
  await Promise.all([
    world(async (w) => {
      const a = await w.release("always", "hang-always");
      await w.point(a);
      const run = w.start({ graceMs: 500, heartbeat: FAST, backoff: { giveUpAfter: 2 } });
      // bounded: a hang that is not counted as a short run would restart forever
      await w.waitFor("the crash-loop exit", () => w.events.some((e) => e.kind === "ended"), 120_000);
      const result = await run.done;
      assert.equal(result.code, SUPERVISOR_EXIT.crashLoop);
      assert.equal(w.events.filter((e) => e.kind === "hung").length, 2);
      assert.deepEqual(w.delays, [1000]);
      assert.deepEqual(w.state().failed, []);
      assert.equal(w.state().known.id, a.id);
      assert.ok(w.state().notices.some((n: any) => n.kind === "failed_start" && n.fallback === false && /gave up/.test(n.reason)), "the crash-loop notice");
      assert.deepEqual(runFiles(w), []);
    }),
    world(async (w) => {
      const a = await w.release("silent", "confirm");
      await w.point(a);
      const run = w.start({ graceMs: 500, heartbeat: { ...FAST, firstBeatMs: 1 }, backoff: { giveUpAfter: 2 } });
      // bounded: a hang that is not counted as a short run would restart forever
      await w.waitFor("the crash-loop exit", () => w.events.some((e) => e.kind === "ended"), 120_000);
      const result = await run.done;
      assert.equal(result.code, SUPERVISOR_EXIT.crashLoop);
      const hung = w.events.filter((e) => e.kind === "hung") as { thresholdMs: number }[];
      assert.equal(hung.length, 2);
      assert.equal(hung[0]!.thresholdMs, 30_000, "a first beat is never required sooner than the stale limit");
      assert.deepEqual(w.state().failed, []);
    }),
    world(async (w) => {
      const a = await w.release("inherit", "confirm");
      await w.point(a);
      const victim = join(w.root, "victim.json");
      const base = { ...process.env, NN_ROOT: w.root, NN_DIST: DIST, NN_ACTIVATION: pathToFileURL(join(import.meta.dirname, "activation.js")).href, NN_PIDS: w.pids, NIMBLENEWT_HEARTBEAT_FILE: victim, NIMBLENEWT_HEARTBEAT_TOKEN: "planted-token-123" };
      const run = w.start({ heartbeat: FAST, child: (release) => ({ command: process.execPath, args: [join(release.dir, "controller.js")], env: base }) });
      await w.waitFor("the confirmation", () => w.state().known?.id === a.id);
      run.stop();
      await run.done;
      const off = w.start({ heartbeat: false, child: (release) => ({ command: process.execPath, args: [join(release.dir, "controller.js")], env: base }) });
      await w.waitFor("the second start", () => w.pidsOf(a).length === 2);
      off.stop();
      await off.done;
      const files = readFileSync(join(w.pids, `${a.id}.env`), "utf8").split("\n").filter(Boolean);
      assert.ok(files[0]!.startsWith(join(w.root, "run", "heartbeat-")), "the launcher's own file, not the inherited one");
      assert.equal(files[1], "none", "heartbeat off: no variables at all");
    }),
  ]);
});
