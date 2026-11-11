import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { LAUNCHER_FILE, Launcher, Supervisor, SUPERVISOR_EXIT, type SupervisorEvent, type SupervisorOptions } from "./index.js";
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
if (behavior === "exit0") process.exit(0);
if (behavior === "secret") console.log(process.env.NN_SECRET);
if (behavior === "stubborn") {
  process.on("SIGTERM", () => {});
  const g = spawn("sleep", ["300"], { stdio: "ignore" });
  appendFileSync(process.env.NN_PIDS + "/" + id + ".gpids", g.pid + "\\n");
  keep();
} else if (behavior === "hang") keep();
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
        child: (release) => ({ command: process.execPath, args: [join(release.dir, "controller.js")], env: { ...process.env, NN_ROOT: root, NN_DIST: DIST, NN_ACTIVATION: pathToFileURL(join(import.meta.dirname, "activation.js")).href, NN_PIDS: pids, NN_SECRET: SECRET } }),
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
    rmSync(root, { recursive: true, force: true });
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

test("a controller that ignores SIGTERM is killed after the grace, with its whole process group, and nothing else (K02a)", async () => {
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
  });
});
