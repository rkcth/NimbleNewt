import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { CONTROLLER_TROUBLE, LAUNCHER_FILE, Launcher, Supervisor, classifyError, diagnoseFailure, hostProbes, type Diagnosis, type LauncherNotice, type Probe, type SupervisorEvent } from "./index.js";
import { Clock, makeRelease, pointerSwitcher, sha256 } from "./start-fixture.js";

/**
 * Card K03, the launcher side: who is at fault when a start or a run fails (the release, the machine or a provider), the owner's health thresholds and probation, and the safe-back line for the schema.
 * No database and no real controller: fake releases on disk, a clock the test moves, probes the test controls, and (for the supervisor) small child processes that exit with chosen codes.
 */
interface W { root: string; clock: Clock; launcher: Launcher; sw: ReturnType<typeof pointerSwitcher>; announce: (tag: string) => Promise<{ id: string; digest: string }>; state: () => any; run: (r: { id: string; digest: string }) => Promise<{ action: string; releaseId?: string }>; problem: { now: Diagnosis | undefined } }
const POLICY = { probationMinutes: 30, maxReleaseFailures: 3, hostRetries: 3 };
const notices = (s: any): LauncherNotice[] => s.notices ?? [];

async function world(body: (w: W) => Promise<void>, policy: typeof POLICY | null = POLICY): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "nn-k03l-"));
  try {
    const clock = new Clock();
    const sw = pointerSwitcher(root);
    const problem: { now: Diagnosis | undefined } = { now: undefined };
    const launcher = new Launcher({ root, switcher: sw, now: clock.now, monotonic: clock.mono, workers: { min: 1, max: 1 }, diagnose: async () => problem.now });
    if (policy !== null) await launcher.setPolicy(policy);
    const protocol = { min: 1, max: 1 };
    const announce = async (tag: string) => { const r = makeRelease(root, tag); await launcher.expect({ ...r, protocol }); return r; };
    const run = async (r: { id: string; digest: string }) => { await sw.write(r.id); return launcher.prepare() as Promise<{ action: string; releaseId?: string }>; };
    await body({ root, clock, launcher, sw, announce, state: () => JSON.parse(readFileSync(join(root, LAUNCHER_FILE), "utf8")), run, problem });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
/** A good release confirmed, then a new one started and confirmed: the new one is under probation with the good one as its fall-back. */
async function rollout(w: W): Promise<{ good: { id: string; digest: string }; next: { id: string; digest: string } }> {
  const good = await w.announce("good");
  assert.equal((await w.run(good)).action, "run");
  assert.equal(await w.launcher.confirm(good.id), true);
  const next = await w.announce("next");
  assert.equal((await w.run(next)).action, "run");
  assert.equal(await w.launcher.confirm(next.id), true);
  return { good, next };
}
const host: Diagnosis = { cause: "host", reason: "the data folder's disk is full", evidence: ["disk"] };

test("a newly confirmed release is watched; failures of its own count, the limit ends the probation, the release is set aside and the launcher falls back to the release before it (K03)", async () => {
  await world(async (w) => {
    const { good, next } = await rollout(w);
    let p = (await w.launcher.rollout()).probation!;
    assert.deepEqual([p.state, p.release, p.prior?.id, p.max], ["watching", next.id, good.id, 3]);
    assert.equal(w.state().known.id, next.id, "promoted at once, as before; the earlier release is kept as the way back");
    const one = await w.launcher.releaseFailure(next.id, "exit code 1");
    assert.deepEqual([one.counted, one.breached, one.failures, one.max], [true, false, 1, 3]);
    assert.equal((await w.launcher.releaseFailure(good.id, "not the one under watch")).counted, false);
    assert.equal((await w.launcher.releaseFailure(next.id, "exit code 1")).breached, false);
    assert.equal(w.state().failed.length, 0, "below the limit nothing is set aside");
    const last = await w.launcher.releaseFailure(next.id, "signal SIGSEGV");
    assert.deepEqual([last.counted, last.breached, last.fellBack, last.failures], [true, true, true, 3]);
    const s = w.state();
    assert.equal(s.known.id, good.id, "the earlier release is the last known good again");
    assert.deepEqual(s.failed.map((f: any) => f.id), [next.id]);
    assert.match(s.failed[0].reason, /probation: 3 runs ended badly/);
    p = (await w.launcher.rollout()).probation!;
    assert.equal(p.state, "breached");
    // the next decision falls back, keeping the reason, and tells the owner once
    const back = await w.launcher.prepare();
    assert.equal((back as { releaseId: string }).releaseId, good.id);
    assert.deepEqual(notices(w.state()).map((n) => `${n.kind}:${n.release}`), [`fell_back:${next.id}`]);
    assert.match(notices(w.state())[0]!.reason, /probation/);
    assert.equal((await w.launcher.releaseFailure(next.id, "late")).counted, false, "a finished probation counts nothing more");
  });
});

test("a probation that runs out without reaching the limit passes, and later failures are not counted against the release (K03)", async () => {
  await world(async (w) => {
    const { next } = await rollout(w);
    await w.launcher.releaseFailure(next.id, "exit code 1");
    w.clock.advance(29 * 60);
    assert.equal((await w.launcher.rollout()).probation!.state, "watching");
    w.clock.advance(60);
    assert.equal((await w.launcher.rollout()).probation!.state, "passed");
    const late = await w.launcher.releaseFailure(next.id, "exit code 1");
    assert.deepEqual([late.counted, late.breached], [false, false]);
    assert.equal(w.state().failed.length, 0);
    assert.equal(w.state().known.id, next.id);
  });
});

test("probation is off unless the owner sets it, and needs a release to fall back to (K03)", async () => {
  await world(async (w) => {
    await rollout(w);
    assert.equal((await w.launcher.rollout()).probation, undefined, "no policy: no probation (the behaviour before K03)");
  }, null);
  await world(async (w) => {
    await w.launcher.setPolicy({ ...POLICY, probationMinutes: 0 });
    await rollout(w);
    assert.equal((await w.launcher.rollout()).probation, undefined, "0 minutes: off");
  });
  await world(async (w) => {
    const first = await w.announce("first");
    await w.run(first);
    await w.launcher.confirm(first.id);
    assert.equal((await w.launcher.rollout()).probation, undefined, "the first release has nothing earlier");
  });
});

test("a breach with nothing sound to fall back to does not set the release aside: it is left running and the owner is told (K03)", async () => {
  await world(async (w) => {
    const { good, next } = await rollout(w);
    // the earlier release was changed on disk: it no longer verifies, so it is not a fall-back
    writeFileSync(join(w.root, "releases", good.id, "nn.js"), "tampered");
    await w.launcher.setPolicy({ ...POLICY, maxReleaseFailures: 1 });
    const r = await w.launcher.releaseFailure(next.id, "exit code 1");
    assert.deepEqual([r.breached, r.fellBack], [false, false], "the policy was copied after the probation began: it keeps the limit it began with");
    const r3 = [await w.launcher.releaseFailure(next.id, "exit code 1"), await w.launcher.releaseFailure(next.id, "exit code 1")][1]!;
    assert.deepEqual([r3.breached, r3.fellBack], [true, false]);
    assert.deepEqual(w.state().failed, [], "nothing is quarantined");
    assert.equal(w.state().known.id, next.id);
    assert.match(notices(w.state())[0]!.reason, /no longer verifies|left running/);
    assert.equal(notices(w.state())[0]!.cause, "probation");
  });
});

test("the owner can end the watch early: nothing is judged afterwards and nothing is undone (K03)", async () => {
  await world(async (w) => {
    const { next } = await rollout(w);
    await w.launcher.releaseFailure(next.id, "exit code 1");
    assert.deepEqual(await w.launcher.stopProbation("I am watching it myself"), { stopped: true, release: next.id });
    const p = (await w.launcher.rollout()).probation!;
    assert.deepEqual([p.state, p.reason], ["stopped", "I am watching it myself"]);
    assert.equal((await w.launcher.releaseFailure(next.id, "exit code 1")).counted, false);
    assert.equal(w.state().known.id, next.id);
    assert.deepEqual(await w.launcher.stopProbation("again"), { stopped: false, release: next.id });
  });
  await world(async (w) => { assert.deepEqual(await w.launcher.stopProbation("nothing to stop"), { stopped: false }); });
});

test("a failure of the machine is not the release's: nothing is quarantined, the start is closed and tried again, and the owner is told after the owner's number of tries (K03)", async () => {
  await world(async (w) => {
    const good = await w.announce("good");
    await w.run(good); await w.launcher.confirm(good.id);
    const next = await w.announce("next");
    assert.equal((await w.run(next)).action, "run");
    assert.equal((await w.launcher.externalFailure(next.id, "host", "ENOSPC")).count, 1);
    assert.equal(w.state().attempt, undefined, "the open start is closed");
    assert.equal(w.state().failed.length, 0);
    const again = await w.run(next);
    assert.deepEqual([again.action, again.releaseId], ["run", next.id], "the same release is started afresh: not set aside, no fall-back");
    assert.equal((await w.launcher.externalFailure(next.id, "host", "ENOSPC")).count, 2);
    assert.equal(notices(w.state()).length, 0, "below the owner's number of tries nobody is told");
    await w.run(next);
    assert.equal((await w.launcher.externalFailure(next.id, "host", "ENOSPC")).count, 3);
    const told = notices(w.state());
    assert.equal(told.length, 1);
    assert.deepEqual([told[0]!.kind, told[0]!.cause, told[0]!.fallback], ["failed_start", "host", true]);
    assert.match(told[0]!.reason, /3 starts of this release in a row failed because of the machine, not the release/);
    await w.run(next);
    await w.launcher.externalFailure(next.id, "host", "ENOSPC");
    assert.equal(notices(w.state()).length, 1, "told once");
    // a different cause starts the count again; a confirmed start ends the trouble
    assert.equal((await w.launcher.externalFailure(next.id, "provider", "rate limit")).count, 1);
    await w.run(next);
    assert.equal(await w.launcher.confirm(next.id), true);
    assert.equal(w.state().external, undefined);
    assert.equal(w.state().known.id, next.id);
  });
});

test("a start that runs out of time while the machine is failing is not judged failed; the same start with a healthy machine is (K03)", async () => {
  await world(async (w) => {
    const good = await w.announce("good");
    await w.run(good); await w.launcher.confirm(good.id);
    const bad = await w.announce("bad");
    await w.run(bad);
    w.clock.advance(300);
    w.problem.now = host;
    const r = await w.launcher.watchdog();
    assert.equal(r.action, "external");
    assert.deepEqual([(r as { cause: string }).cause, (r as { count: number }).count], ["host", 1]);
    assert.match((r as { reason: string }).reason, /startup window; the data folder's disk is full/);
    assert.equal(w.state().failed.length, 0, "not quarantined");
    assert.equal(w.state().known.id, good.id);
    assert.equal((await w.launcher.watchdog()).action, "none", "the start was closed");
    // started afresh with a healthy machine: it does fail the window, and is set aside
    const again = await w.run(bad);
    assert.deepEqual([again.action, again.releaseId], ["run", bad.id]);
    w.problem.now = undefined;
    w.clock.advance(300);
    assert.equal((await w.launcher.watchdog()).action, "failed");
    assert.deepEqual(w.state().failed.map((f: any) => f.id), [bad.id]);
    // a diagnosis of "release" or a probe that throws blames the release too
    const second = await w.announce("second");
    await w.run(second);
    w.problem.now = { cause: "release", reason: "x", evidence: [] };
    w.clock.advance(300);
    assert.equal((await w.launcher.watchdog()).action, "failed");
  });
  await world(async (w) => {
    const throwing = new Launcher({ root: w.root, switcher: w.sw, now: w.clock.now, monotonic: w.clock.mono, workers: { min: 1, max: 1 }, diagnose: async () => { throw new Error("probe broke"); } });
    const good = await w.announce("good"); await w.run(good); await throwing.confirm(good.id);
    const bad = await w.announce("bad"); await w.run(bad);
    w.clock.advance(300);
    assert.equal((await throwing.watchdog()).action, "failed", "a failing probe never blames the machine");
  });
});

test("the safe-back line lets a fall-back to a release the data has outgrown through while the rollback period is open (K02d, K03)", async () => {
  await world(async (w) => {
    const good = await w.announce("good");
    // an older release that understands schema 1 only; the database has since gone to 2 through an additive migration
    const dir = join(w.root, "releases", good.id);
    writeFileSync(join(dir, "compat.json"), JSON.stringify({ protocol: { min: 1, max: 1 }, schema: { min: 1, max: 1 } }));
    const manifest = JSON.stringify({ candidateId: good.id, sourceCommit: "a".repeat(40), files: { "nn.js": { sha256: sha256("release good"), size: 12 }, "compat.json": { sha256: sha256(readFileSync(join(dir, "compat.json"), "utf8")), size: readFileSync(join(dir, "compat.json")).length } } });
    writeFileSync(join(dir, "MANIFEST.json"), manifest);
    const g = { id: good.id, digest: sha256(manifest) };
    await w.launcher.expect({ ...g, protocol: { min: 1, max: 1 } });
    await w.run(g); await w.launcher.confirm(g.id);
    await w.launcher.noteDatabase(2, "controller");
    const next = await w.announce("next");
    await w.run(next);
    w.clock.advance(300);
    assert.equal((await w.launcher.watchdog()).action, "late", "schema 2 is past what the known good understands: it is not a fall-back (K02d)");
    // the guard says every migration above 1 is additive and the period is open for a day
    const until = new Date(Date.parse(w.clock.now()) + 86_400_000).toISOString();
    await w.launcher.noteDatabase(2, "controller", { backTo: 1, until });
    assert.deepEqual({ backTo: w.state().db.safeBackTo, until: w.state().db.safeUntil }, { backTo: 1, until });
    const next2 = await w.announce("next2");
    await w.run(next2);
    w.clock.advance(300);
    assert.equal((await w.launcher.watchdog()).action, "failed", "inside the period the known good may come back");
    // past the period it is refused again
    const next3 = await w.announce("next3");
    await w.run(next3);
    w.clock.advance(2 * 86_400);
    assert.equal((await w.launcher.watchdog()).action, "late");
    // a raised schema without a new line clears the line; null clears it explicitly
    await w.launcher.noteDatabase(3, "controller");
    assert.equal(w.state().db.safeBackTo, undefined);
    await w.launcher.noteDatabase(3, "controller", { backTo: 1, until });
    await w.launcher.noteDatabase(3, "controller", null);
    assert.equal(w.state().db.safeBackTo, undefined);
  });
});

test("a damaged policy, probation or external record in the file is dropped, not a reason to block the launch (K03)", async () => {
  await world(async (w) => {
    const good = await w.announce("good");
    await w.run(good); await w.launcher.confirm(good.id);
    const s = w.state();
    writeFileSync(join(w.root, LAUNCHER_FILE), JSON.stringify({ ...s, policy: { probationMinutes: -5 }, probation: { release: "x" }, external: { release: good.id, cause: "weather", count: 1 } }));
    const read = await w.launcher.read();
    assert.deepEqual([read.policy, read.probation, read.external], [undefined, undefined, undefined]);
    assert.equal((await w.launcher.prepare()).action, "run");
  });
});

test("the diagnosis: the controller's own word, then what the probes see, then the release (K03)", async () => {
  const quiet: Probe[] = [async () => undefined];
  assert.deepEqual((await diagnoseFailure({ code: CONTROLLER_TROUBLE.host, signal: null }, quiet)).cause, "host");
  assert.deepEqual((await diagnoseFailure({ code: CONTROLLER_TROUBLE.provider, signal: null }, quiet)).cause, "provider");
  assert.equal((await diagnoseFailure({ code: null, signal: null, spawnFailed: true }, quiet)).cause, "release", "a program that cannot be started is the release's, as before");
  assert.equal((await diagnoseFailure({ code: null, signal: null, spawnFailed: true }, [async () => ({ cause: "host" as const, problem: "disk full" })])).cause, "host", "unless the machine is seen to be at fault");
  const release = await diagnoseFailure({ code: 1, signal: null }, quiet);
  assert.equal(release.cause, "release"); assert.match(release.reason, /exit code 1 while the machine and the providers looked healthy/);
  assert.match((await diagnoseFailure({ code: null, signal: "SIGSEGV" }, quiet)).reason, /signal SIGSEGV/);
  const full: Probe = async () => ({ cause: "host", problem: "disk full" });
  const down: Probe = async () => ({ cause: "provider", problem: "model server unreachable" });
  assert.deepEqual([(await diagnoseFailure({ code: 1, signal: null }, [full])).cause, (await diagnoseFailure({ code: 1, signal: null }, [down])).cause], ["host", "provider"]);
  assert.equal((await diagnoseFailure({ code: 1, signal: null }, [down, full])).cause, "host", "a host problem outranks a provider problem");
  const throwing: Probe = async () => { throw new Error("broke"); };
  assert.equal((await diagnoseFailure({ code: 1, signal: null }, [throwing])).cause, "release", "a probe that fails finds nothing");
  // the controller's exit code beats a quiet machine, and is not undone by a probe that finds nothing
  assert.equal((await diagnoseFailure({ code: 76, signal: null }, [])).cause, "host");
});

test("errors that say the machine failed are told from errors of the program, also through a cause chain (K03)", () => {
  const code = (c: string, m = "x"): Error => Object.assign(new Error(m), { code: c });
  for (const c of ["ENOSPC", "EACCES", "EMFILE", "EADDRINUSE", "ECONNREFUSED", "EROFS"]) assert.equal(classifyError(code(c))?.cause, "host", c);
  assert.equal(classifyError(new Error("write failed", { cause: code("ENOSPC") }))?.cause, "host");
  assert.equal(classifyError(new Error("No space left on device"))?.cause, "host");
  assert.equal(classifyError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { kind: "unavailable" }))?.cause, "host");
  assert.equal(classifyError(new Error("the provider is rate limited"))?.cause, "provider");
  assert.equal(classifyError(new TypeError("x is not a function")), undefined);
  assert.equal(classifyError(code("ENOENT")), undefined);
  assert.equal(classifyError("a string"), undefined);
  assert.equal(classifyError(undefined), undefined);
  const loop: { cause?: unknown } = {}; loop.cause = loop;
  assert.equal(classifyError(loop), undefined, "a cause that points at itself ends");
});

test("the launcher's own probes: free space below the limit, a data folder that cannot be written, memory (K03)", async () => {
  const run = async (o: Parameters<typeof hostProbes>[0]): Promise<string[]> => { const out: string[] = []; for (const p of hostProbes(o)) { const r = await p(); if (r !== undefined) out.push(r.problem); } return out; };
  const fine = { dataDir: "/data", freeBytes: async () => 10 * 1024 ** 3, writable: async () => true, freeMemory: () => 4 * 1024 ** 3 };
  assert.deepEqual(await run(fine), []);
  assert.match((await run({ ...fine, freeBytes: async () => 100 * 1024 * 1024 }))[0]!, /100 MiB free \(less than 256 MiB\)/);
  assert.deepEqual(await run({ ...fine, freeBytes: async () => 100, minFreeBytes: 50 }), []);
  assert.deepEqual(await run({ ...fine, writable: async () => false }), ["the data folder cannot be written"]);
  assert.match((await run({ ...fine, freeMemory: () => 1024 * 1024 }))[0]!, /1 MiB of memory is free/);
  assert.deepEqual(await run({ ...fine, freeBytes: async () => { throw new Error("no statfs"); }, writable: async () => { throw new Error("no"); } }), [], "a probe that cannot run finds nothing");
  assert.deepEqual(await run({ freeMemory: () => 4 * 1024 ** 3 }), [], "without a data folder only memory is checked");
  // the real probes run on a real folder without finding a problem on a healthy machine
  const real = mkdtempSync(join(tmpdir(), "nn-k03p-"));
  try { assert.deepEqual(await run({ dataDir: real, minFreeBytes: 1, minFreeMemory: 1 }), []); } finally { rmSync(real, { recursive: true, force: true }); }
});

// ---- the supervisor, with small child processes that exit with chosen codes -------------------------------------------------------------------------------------------------

const DIST = pathToFileURL(join(import.meta.dirname, "launcher.js")).href;
const PROTOCOL = { min: 1, max: 1 };
const controllerSource = (behavior: string): string => `
const id = process.env.NIMBLENEWT_RUNNING_RELEASE;
const mod = await import(process.env.NN_DIST);
const { PointerSwitcher } = await import(process.env.NN_ACTIVATION);
const launcher = new mod.Launcher({ root: process.env.NN_ROOT, switcher: new PointerSwitcher(process.env.NN_ROOT) });
const behavior = ${JSON.stringify(behavior)};
const keep = () => setInterval(() => {}, 1000);
if (behavior === "host-trouble") process.exit(${CONTROLLER_TROUBLE.host});
else if (behavior === "provider-trouble") process.exit(${CONTROLLER_TROUBLE.provider});
else if (behavior === "crash") process.exit(1);
else if (behavior === "confirm-then-crash") { await launcher.confirm(id); setTimeout(() => process.exit(1), 30); keep(); }
else { await launcher.confirm(id); keep(); }
`;

async function supervised(body: (s: { root: string; clock: Clock; launcher: Launcher; events: SupervisorEvent[]; lines: string[]; release: (tag: string, behavior: string) => Promise<{ id: string; digest: string }>; state: () => any; start: (probes?: readonly Probe[]) => { done: Promise<{ code: number; reason: string }>; stop(): void }; waitFor: (what: string, cond: () => boolean) => Promise<void> }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "nn-k03s-"));
  const clock = new Clock();
  const sw = pointerSwitcher(root);
  const launcher = new Launcher({ root, switcher: sw, now: clock.now, monotonic: clock.mono, workers: PROTOCOL });
  await launcher.setPolicy(POLICY);
  const events: SupervisorEvent[] = [];
  const lines: string[] = [];
  const stops: (() => void)[] = [];
  try {
    await body({
      root, clock, launcher, events, lines,
      async release(tag, behavior) {
        const id = `rcn-${sha256(`k03-${tag}`).slice(0, 24)}`;
        const dir = join(root, "releases", id);
        mkdirSync(dir, { recursive: true });
        const text = controllerSource(behavior);
        writeFileSync(join(dir, "controller.js"), text);
        const manifest = JSON.stringify({ candidateId: id, sourceCommit: "a".repeat(40), files: { "controller.js": { sha256: sha256(text), size: Buffer.byteLength(text) } } });
        writeFileSync(join(dir, "MANIFEST.json"), manifest);
        const r = { id, digest: sha256(manifest) };
        await launcher.expect({ ...r, protocol: PROTOCOL });
        return r;
      },
      state: () => JSON.parse(readFileSync(join(root, LAUNCHER_FILE), "utf8")),
      start(probes = []) {
        const ac = new AbortController();
        const sup = new Supervisor({
          launcher, signal: ac.signal, pollMs: 10, graceMs: 2000, stdio: "ignore", heartbeat: false, probes,
          child: (release) => ({ command: process.execPath, args: [join(release.dir, "controller.js")], env: { ...process.env, NN_ROOT: root, NN_DIST: DIST, NN_ACTIVATION: pathToFileURL(join(import.meta.dirname, "activation.js")).href }, cwd: release.dir }),
          log: (l) => lines.push(l), onEvent: (e) => events.push(e), sleep: async () => undefined,
        });
        const done = sup.run();
        stops.push(() => ac.abort());
        return { done, stop: () => ac.abort() };
      },
      async waitFor(what, cond) {
        const end = Date.now() + 30_000;
        while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}; events: ${JSON.stringify(events)}; lines: ${JSON.stringify(lines)}`); await new Promise((r) => setTimeout(r, 15)); }
      },
    });
  } finally { for (const s of stops) s(); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
}
const startsOf = (events: SupervisorEvent[], id: string): number => events.filter((e) => e.kind === "started" && e.releaseId === id).length;

test("a controller that exits 76 before confirming is not set aside: it is started again, counted, and the owner is told after the owner's number of tries (K03, supervisor)", async () => {
  await supervised(async (s) => {
    const good = await s.release("good", "confirm");
    await pointerTo(s.root, good);
    await s.launcher.prepare(); await s.launcher.confirm(good.id);
    const bad = await s.release("bad", "host-trouble");
    await pointerTo(s.root, bad);
    const run = s.start();
    await s.waitFor("three tries", () => startsOf(s.events, bad.id) >= 3 && notices(s.state()).length === 1);
    run.stop();
    await run.done;
    const st = s.state();
    assert.deepEqual(st.failed, [], "never set aside");
    assert.equal(st.known.id, good.id);
    assert.equal(startsOf(s.events, good.id), 0, "never fell back");
    assert.equal(st.external.cause, "host");
    assert.ok(st.external.count >= 3);
    assert.equal(notices(st)[0]!.cause, "host");
    assert.ok(s.lines.some((l) => /the machine is at fault \(the controller reported that the machine stopped it \(exit 76\)\); the release is not set aside/.test(l)), s.lines.join("\n"));
  });
});

test("the same exit code from a machine whose probes find nothing wrong is the release's: exit 1 is set aside and the launcher falls back (K03, supervisor)", async () => {
  await supervised(async (s) => {
    const good = await s.release("good", "confirm");
    await pointerTo(s.root, good);
    await s.launcher.prepare(); await s.launcher.confirm(good.id);
    const bad = await s.release("bad", "crash");
    await pointerTo(s.root, bad);
    const run = s.start([async () => undefined]);
    await s.waitFor("the fall-back", () => startsOf(s.events, good.id) >= 1);
    run.stop();
    await run.done;
    assert.deepEqual(s.state().failed.map((f: any) => f.id), [bad.id]);
    assert.equal(s.state().external, undefined);
  });
});

test("the same exit 1 while the disk is full is the machine's: the release is not set aside (K03, supervisor probes)", async () => {
  await supervised(async (s) => {
    const good = await s.release("good", "confirm");
    await pointerTo(s.root, good);
    await s.launcher.prepare(); await s.launcher.confirm(good.id);
    const bad = await s.release("bad", "crash");
    await pointerTo(s.root, bad);
    const run = s.start([async () => ({ cause: "host", problem: "the data folder's disk has 3 MiB free (less than 256 MiB)" })]);
    await s.waitFor("three tries", () => startsOf(s.events, bad.id) >= 3);
    run.stop();
    await run.done;
    assert.deepEqual(s.state().failed, []);
    assert.equal(startsOf(s.events, good.id), 0);
    assert.match(s.state().external.reason, /3 MiB free/);
  });
});

test("a release that confirms and then keeps crashing during its probation is set aside at the owner's limit and the launcher goes back to the release before it (K03, supervisor)", async () => {
  await supervised(async (s) => {
    const good = await s.release("good", "confirm");
    await pointerTo(s.root, good);
    await s.launcher.prepare(); await s.launcher.confirm(good.id);
    const next = await s.release("next", "confirm-then-crash");
    await pointerTo(s.root, next);
    const run = s.start([async () => undefined]);
    await s.waitFor("the fall-back to the earlier release", () => startsOf(s.events, good.id) >= 1 && s.state().known?.id === good.id);
    await s.waitFor("the earlier release to confirm", () => s.state().attempt?.id === good.id && s.state().attempt.confirmedAt !== undefined);
    run.stop();
    await run.done;
    const st = s.state();
    assert.deepEqual(st.failed.map((f: any) => f.id), [next.id]);
    assert.ok(startsOf(s.events, next.id) >= 3, "it was tried at least up to the limit");
    assert.equal(st.probation.state, "breached");
    assert.equal(st.probation.failures.length, 3);
    assert.deepEqual(notices(st).map((n) => n.kind), ["fell_back"]);
  });
});

async function pointerTo(root: string, r: { id: string }): Promise<void> { await pointerSwitcher(root).write(r.id); }
