import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { SandboxLauncher, type LaunchRecord } from "./launcher.js";
import { detectLimitCapabilities, limitedPlan, type LimitCapabilities } from "./limits.js";
import { ResourceWatch, judge, measureDirs, newJudgeState, parseCpuTime, parsePsUsage, psSampler, type UsageSample } from "./resource-watch.js";
import type { SandboxRecipe } from "./recipe.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-rwatch-")));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const dir = (name: string): string => { const p = join(root, name); mkdirSync(p, { recursive: true }); return p; };
const recipe = (): SandboxRecipe => { const n = ++counter; return { mode: "trusted-host", workdir: dir(`w${n}`), home: dir(`h${n}`), scratch: dir(`s${n}`), readOnly: [], network: "none", env: {}, protectedSubpaths: [] }; };
const sample = (extra: Partial<UsageSample> = {}): UsageSample => ({ pids: [10], processes: 1, rssMb: 10, cpuMs: 0, ...extra });
const base = { file: "/usr/bin/sandbox-exec", args: ["-p", "profile", "/bin/sh"], env: {} };
const sampled = (platform: NodeJS.Platform, extra: Partial<LimitCapabilities> = {}): LimitCapabilities => ({ platform, cgroupScope: false, escapeDollar: false, prlimit: false, taskset: false, passEnv: {}, ...extra });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("the sampling monitor: reading the system", () => {
  test("CPU time is read in the formats Linux and macOS print, and nothing else", () => {
    assert.equal(parseCpuTime("0:01.50"), 1500);
    assert.equal(parseCpuTime("00:00:02"), 2000);
    assert.equal(parseCpuTime("1:02:03.25"), 3723250);
    assert.equal(parseCpuTime("2-01:00:00"), (49 * 3600) * 1000);
    for (const bad of ["", "abc", "1:2:3:4", "-1:00", "1.5", "99999-00:00:00"]) assert.equal(parseCpuTime(bad), undefined, bad);
  });

  test("the run's tree is summed from ps output: its own children and theirs, not other processes", () => {
    const out = [
      "    1     0  1000 0:10.00", "  100     1  2048 0:01.00", "  101   100  4096 0:02.50", "  102   101  1024 0:00.50", "  200     1  9999 5:00.00",
      "garbage line", "  300   100  notanumber 0:01.00", "  301   100  512 not-a-time",
    ].join("\n");
    const u = parsePsUsage(out, 100)!;
    assert.deepEqual([...u.pids].sort(), [100, 101, 102]);
    assert.equal(u.processes, 3);
    assert.equal(u.rssMb, (2048 + 4096 + 1024) / 1024);
    assert.equal(u.cpuMs, 4000);
    assert.equal(parsePsUsage(out, 999), undefined, "a root that is not listed has ended");
  });

  test("macOS CPU time past 999 minutes is read, so a long-running process and its subtree are not dropped", () => {
    assert.equal(parseCpuTime("1234:56.78"), (1234 * 60 + 56) * 1000 + 780);
    const u = parsePsUsage("  100     1  1000 1234:56.78\n  101   100  1000 0:01.00", 100)!;
    assert.equal(u.processes, 2);
  });

  test("a process handed to init stays a member: by its process group, or by its start time once seen; an unrelated one never is", () => {
    const line = (pid: number, ppid: number, pgid: number, start = "Wed Nov 11 10:00:00 2026") => `${pid} ${ppid} ${pgid} 1024 0:01.00 ${start}`;
    const out = [line(1, 0, 1), line(100, 1, 100), line(101, 100, 100), line(102, 1, 100), line(103, 102, 103), line(104, 1, 104), line(200, 1, 200), line(201, 200, 100)].join("\n");
    const known = new Map<number, string>();
    const u = parsePsUsage(out, 100, known)!;
    assert.deepEqual([...u.pids].sort(), [100, 101, 102, 103, 201], "the orphan 102 (group 100), its child 103 in its own group, and 201 in the group under an unrelated parent");
    assert.equal(u.rssMb, 5);
    // The launched process and the intermediate have exited; 103 left the group, its parent is gone, and it is still followed by its start time. 104 is someone else's.
    const later = [line(1, 0, 1), line(103, 1, 103), line(104, 1, 104), line(105, 103, 105)].join("\n");
    assert.deepEqual([...parsePsUsage(later, 100, known)!.pids].sort(), [103, 105]);
    assert.equal(parsePsUsage([line(1, 0, 1), line(103, 1, 103, "Wed Nov 11 11:00:00 2026")].join("\n"), 100, known), undefined, "a reused process id (another start time) is not the run's");
    assert.equal(parsePsUsage([line(1, 0, 1), line(104, 1, 104)].join("\n"), 1), undefined, "init is never a run");
  });

  test("the ps call is bounded in time: a hanging ps is given up", async (t) => {
    if (process.platform === "win32") return t.skip("needs a shell");
    const fake = join(dir("fake-ps"), "ps");
    writeFileSync(fake, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const t0 = Date.now();
    assert.equal(await psSampler(fake, 300)(process.pid), undefined);
    assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  });

  test("a file with two names is counted once", async (t) => {
    if (process.platform === "win32") return t.skip("hard links");
    const d = dir("hardlinks");
    writeFileSync(join(d, "a"), "x".repeat(3000));
    linkSync(join(d, "a"), join(d, "b"));
    assert.equal((await measureDirs([d])).bytes, 3000);
  });

  test("a parent cycle in the listing cannot loop the walk", () => {
    const u = parsePsUsage("5 6 10 0:01.00\n6 5 10 0:01.00", 5)!;
    assert.equal(u.processes, 2);
  });

  test("the real ps sampler sees a real process tree (this host's ps)", async (t) => {
    const child = spawn("/bin/sh", ["-c", "sleep 30 & sleep 30 & wait"], { stdio: "ignore" });
    try {
      const sampler = psSampler();
      let u: UsageSample | undefined;
      for (let i = 0; i < 40 && (u === undefined || u.processes < 3); i++) { await sleep(100); u = await sampler(child.pid!); }
      if (u === undefined) return t.skip("ps cannot list processes here");
      assert.equal(u.processes, 3);
      assert.ok(u.rssMb > 0);
      process.kill(child.pid!, "SIGKILL");
    } finally { try { execFileSync("pkill", ["-P", String(child.pid)], { stdio: "ignore" }); } catch { /* none */ } child.kill("SIGKILL"); }
    await sleep(100);
    assert.equal(await psSampler()(child.pid!), undefined, "an ended process is not there");
    assert.equal(await psSampler("/nonexistent/ps")(1), undefined, "a sampler that cannot run says nothing");
  });

  test("directory sizes count files, never follow links out of the agent's directories, and stop at the bound", async () => {
    const d = dir("measure"); const outside = dir("measure-outside");
    writeFileSync(join(d, "a"), "x".repeat(1000));
    mkdirSync(join(d, "sub")); writeFileSync(join(d, "sub", "b"), "y".repeat(500));
    writeFileSync(join(outside, "huge"), "z".repeat(100_000));
    symlinkSync(outside, join(d, "link"));
    const m = await measureDirs([d]);
    assert.equal(m.truncated, false);
    assert.ok(m.bytes >= 1500 && m.bytes < 50_000, `${m.bytes}: the linked directory's 100000 bytes must not be counted`);
    for (let i = 0; i < 20; i++) writeFileSync(join(d, `f${i}`), "q");
    assert.deepEqual((await measureDirs([d], 5)).truncated, true);
    assert.deepEqual(await measureDirs([join(root, "does-not-exist")]), { bytes: 0, truncated: false });
  });
});

describe("the sampling monitor: the decision", () => {
  test("memory, process count and disk each end the run past their limit, and only past it", () => {
    const state = newJudgeState();
    assert.deepEqual(judge({ memoryMb: 100 }, sample({ rssMb: 100 }), undefined, 0, state), { action: "ok" });
    assert.deepEqual(judge({ memoryMb: 100 }, sample({ rssMb: 100.5 }), undefined, 0, state), { action: "kill", exceeded: { limit: "memoryMb", value: 100, observed: 101 } });
    assert.deepEqual(judge({ processes: 3 }, sample({ processes: 3 }), undefined, 0, state), { action: "ok" });
    assert.deepEqual(judge({ processes: 3 }, sample({ processes: 4 }), undefined, 0, state), { action: "kill", exceeded: { limit: "processes", value: 3, observed: 4 } });
    assert.deepEqual(judge({ diskMb: 1 }, sample(), { bytesWritten: 1048576 }, 0, state), { action: "ok" });
    assert.deepEqual(judge({ diskMb: 1 }, sample(), { bytesWritten: 3 * 1048576 }, 0, state), { action: "kill", exceeded: { limit: "diskMb", value: 1, observed: 3 } });
    assert.deepEqual(judge({ diskMb: 1 }, sample(), undefined, 0, state), { action: "ok" }, "no disk figure yet is not a violation");
  });

  test("CPU: a burst is allowed, a sustained excess is paused, an idle spell refills, and a drop in the figure is never a refund", () => {
    const state = newJudgeState();
    const at = (t: number, cpuMs: number) => judge({ cpus: 1 }, sample({ cpuMs }), undefined, t, state);
    assert.deepEqual(at(0, 0), { action: "ok" });
    assert.deepEqual(at(250, 500), { action: "ok" }, "twice its share for a moment is inside the burst");
    let paused = 0;
    for (let t = 500, cpu = 500; t <= 5000; t += 250) { cpu += 500; const v = at(t, cpu); if (v.action === "pause") { paused++; assert.ok(v.ms >= 50 && v.ms <= 2000, String(v.ms)); } }
    assert.ok(paused > 0, "two cores' worth of use for seconds must be paced");
    const idle = newJudgeState();
    const quiet = (t: number, cpuMs: number) => judge({ cpus: 2 }, sample({ cpuMs }), undefined, t, idle);
    quiet(0, 0);
    assert.deepEqual(quiet(10_000, 100), { action: "ok" });
    assert.deepEqual(quiet(10_250, 100 + 1000), { action: "ok" });
    const dropped = newJudgeState();
    judge({ cpus: 1 }, sample({ cpuMs: 9000 }), undefined, 0, dropped);
    judge({ cpus: 1 }, sample({ cpuMs: 0 }), undefined, 10, dropped);
    assert.ok(dropped.credit <= CPU_BURST, "a child that exited does not hand credit back");
    const cpuPause = judge({ cpus: 1 }, sample({ cpuMs: 100_000 }), undefined, 20, dropped);
    assert.equal(cpuPause.action, "pause");
  });
});
const CPU_BURST = 2000;

describe("the sampling monitor: acting on the decision", () => {
  const watch = (over: Partial<ConstructorParameters<typeof ResourceWatch>[0]>) => {
    const events: string[] = [];
    const w = new ResourceWatch({ limits: {}, rootPid: 10, sample: async () => sample(), onExceeded: (e) => { events.push(`exceeded ${e.limit}`); }, signal: (pid, s) => { events.push(`${s} ${pid}`); }, ...over });
    return { w, events };
  };

  test("a run past its limit is reported once and no further looks follow", async () => {
    let looks = 0;
    const { w, events } = watch({ limits: { memoryMb: 5 }, sample: async () => { looks++; return sample({ rssMb: 50 }); } });
    await w.tick(); await w.tick(); await w.tick();
    assert.deepEqual(events, ["exceeded memoryMb"]);
    assert.equal(looks, 1);
  });

  test("a run past its CPU share is stopped and then continued, every process of the tree, and stop() continues anything still paused", async () => {
    let cpu = 0; let t = 0;
    const { w, events } = watch({ limits: { cpus: 1 }, now: () => t, sample: async () => sample({ pids: [10, 11], cpuMs: cpu }) });
    for (let i = 0; i < 20 && w.pauses === 0; i++) { t += 250; cpu += 1500; await w.tick(); }
    assert.equal(w.pauses, 1);
    assert.deepEqual(events.slice(-2), ["SIGSTOP 10", "SIGSTOP 11"].slice(-2));
    await sleep(2100);
    assert.deepEqual(events.slice(-2), ["SIGCONT 10", "SIGCONT 11"], "resumed after the pause");
    events.length = 0;
    for (let i = 0; i < 20 && w.pauses < 2; i++) { t += 250; cpu += 1500; await w.tick(); }
    assert.equal(w.pauses, 2);
    events.length = 0;
    w.stop();
    assert.deepEqual(events, ["SIGCONT 10", "SIGCONT 11"], "a run that ends while paused is resumed (so it can be killed and reaped)");
    events.length = 0;
    w.stop();
    assert.deepEqual(events, [], "nothing is signalled twice");
  });

  test("looks do not overlap, a failing look decides nothing, and a stopped watch looks no more", async () => {
    let inside = 0; let max = 0; let fail = true;
    const { w, events } = watch({ limits: { memoryMb: 5 }, sample: async () => { inside++; max = Math.max(max, inside); await sleep(30); inside--; if (fail) throw new Error("ps broke"); return sample({ rssMb: 50 }); } });
    await Promise.all([w.tick(), w.tick(), w.tick()]);
    assert.equal(max, 1);
    assert.deepEqual(events, []);
    fail = false;
    w.stop();
    await w.tick();
    assert.deepEqual(events, []);
  });

  test("disk growth is measured against the size at the start, by its own looks", async () => {
    let measures = 0; let bytes = 10_000_000;
    const { w, events } = watch({ limits: { diskMb: 5 }, disk: { dirs: ["/x"], baselineBytes: 10_000_000, measure: async () => { measures++; return { bytes, truncated: false }; } } });
    await w.diskTick(); assert.deepEqual(events, [], "an existing checkout is not the agent's writing");
    await w.tick();
    assert.equal(measures, 1, "a look at the processes does not walk the directories");
    bytes = 10_000_000 + 4 * 1048576; await w.diskTick(); assert.deepEqual(events, [], "4 MiB of 5");
    bytes = 10_000_000 + 6 * 1048576; await w.diskTick();
    assert.deepEqual(events, ["exceeded diskMb"]);
    await w.diskTick(); await w.tick();
    assert.deepEqual(events, ["exceeded diskMb"], "reported once");
    assert.throws(() => new ResourceWatch({ limits: { diskMb: 1 }, rootPid: 1, sample: async () => undefined, onExceeded: () => undefined }), /directories/);
  });

  test("a slow directory walk never holds up the looks at memory and CPU", async () => {
    let rss = 1;
    const { w, events } = watch({ limits: { diskMb: 5, memoryMb: 5 }, sample: async () => sample({ rssMb: rss }), disk: { dirs: ["/x"], baselineBytes: 0, measure: () => new Promise(() => undefined) } });
    void w.diskTick();
    await w.tick(); assert.deepEqual(events, []);
    rss = 50; await w.tick();
    assert.deepEqual(events, ["exceeded memoryMb"], "the memory limit acted while the walk was still going");
  });

  test("the kernel, init, the launcher itself and its parent are never signalled, whatever a look said", async () => {
    let t = 0; let cpu = 0;
    const { w, events } = watch({ limits: { cpus: 1 }, now: () => t, sample: async () => sample({ pids: [0, 1, process.pid, process.ppid, 4242], cpuMs: cpu }) });
    for (let i = 0; i < 20 && w.pauses === 0; i++) { t += 250; cpu += 1500; await w.tick(); }
    assert.equal(w.pauses, 1);
    assert.deepEqual(events, ["SIGSTOP 4242"]);
    w.stop();
    assert.deepEqual(events, ["SIGSTOP 4242", "SIGCONT 4242"]);
  });

  test("a launcher process that exits while a tree is paused continues it on the way out", async (t) => {
    if (process.platform === "win32") return t.skip("needs signals");
    const victim = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore", detached: true });
    try {
      const url = new URL("./resource-watch.js", import.meta.url).href;
      const script = `import { ResourceWatch } from ${JSON.stringify(url)};
        let t = 0, cpu = 0;
        const w = new ResourceWatch({ limits: { cpus: 1 }, rootPid: ${victim.pid}, now: () => t, sample: async () => ({ pids: [${victim.pid}], processes: 1, rssMb: 1, cpuMs: cpu }), onExceeded: () => {} });
        for (let i = 0; i < 20 && w.pauses === 0; i++) { t += 250; cpu += 1500; await w.tick(); }
        if (w.pauses !== 1) process.exit(3);
        process.exit(0);`;
      execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
      const state = execFileSync("ps", ["-o", "stat=", "-p", String(victim.pid)], { encoding: "utf8" }).trim();
      assert.ok(!state.startsWith("T"), `the paused process was left stopped (${state})`);
    } finally { victim.kill("SIGKILL"); }
  });

  test("a pause is bounded and its continue is armed even when stopping a process fails", async () => {
    let t = 0; let cpu = 0;
    const events: string[] = [];
    const w = new ResourceWatch({ limits: { cpus: 0.01 }, rootPid: 10, now: () => t, sample: async () => sample({ pids: [10], cpuMs: cpu }), onExceeded: () => undefined, signal: (pid, s) => { events.push(`${s} ${pid}`); if (s === "SIGSTOP") throw new Error("EPERM"); } });
    for (let i = 0; i < 5 && w.pauses === 0; i++) { t += 250; cpu += 100_000; await w.tick(); }
    assert.equal(w.pauses, 1);
    await sleep(2100);
    assert.deepEqual(events, ["SIGSTOP 10", "SIGCONT 10"]);
    w.stop();
  });
});

describe("the sampling monitor: the plan and what is reported", () => {
  const all = { cpus: 1, memoryMb: 64, diskMb: 10, processes: 5 };

  test("macOS with a working ps and directory walk reports every limit as partial, says by what and what is missed, leaves the plan alone, and hands the launcher the watch", () => {
    const r = limitedPlan(base, all, sampled("darwin", { processSampler: true, diskSampler: true }));
    assert.deepEqual(r.report.map((x) => [x.limit, x.enforced]), [["cpus", "partial"], ["diskMb", "partial"], ["memoryMb", "partial"], ["processes", "partial"]]);
    assert.ok(r.report.every((x) => /sampling monitor/.test(x.by ?? "") && x.detail.length > 40));
    assert.match(r.report.find((x) => x.limit === "memoryMb")!.detail, /between two looks/);
    assert.deepEqual(r.plan, base);
    assert.deepEqual(r.watch, { cpus: 1, diskMb: 10, memoryMb: 64, processes: 5 });
  });

  test("a mechanism that was not seen to work is not claimed: none, with the reason, and no watch", () => {
    for (const caps of [sampled("darwin"), sampled("darwin", { processSampler: false, diskSampler: false })]) {
      const r = limitedPlan(base, all, caps);
      assert.deepEqual(r.report.map((x) => x.enforced), ["none", "none", "none", "none"]);
      assert.equal(r.watch, undefined);
      assert.match(r.report[0]!.detail, /darwin/);
    }
    const onlyDisk = limitedPlan(base, all, sampled("darwin", { diskSampler: true }));
    assert.deepEqual(onlyDisk.report.map((x) => [x.limit, x.enforced]), [["cpus", "none"], ["diskMb", "partial"], ["memoryMb", "none"], ["processes", "none"]]);
    assert.deepEqual(onlyDisk.watch, { diskMb: 10 });
  });

  test("Windows holds only the disk limit (host paths); CPU, memory and processes are none and the reason is the VM guest, not a missing feature", () => {
    const r = limitedPlan(base, all, sampled("win32", { processSampler: true, diskSampler: true }));
    // Even a mistaken processSampler flag cannot make a Windows guest's processes visible.
    assert.deepEqual(r.report.map((x) => [x.limit, x.enforced]), [["cpus", "none"], ["diskMb", "partial"], ["memoryMb", "none"], ["processes", "none"]]);
    const honest = limitedPlan(base, all, sampled("win32", { diskSampler: true }));
    assert.deepEqual(honest.report.map((x) => [x.limit, x.enforced]), [["cpus", "none"], ["diskMb", "partial"], ["memoryMb", "none"], ["processes", "none"]]);
    assert.match(honest.report.find((x) => x.limit === "memoryMb")!.detail, /Windows Sandbox guest.*Job Object/);
    assert.deepEqual(honest.watch, { diskMb: 10 });
  });

  test("the capability detector claims a sampler only for the host it ran on, and Windows never gets a process sampler", async () => {
    for (const other of ["darwin", "win32"] as const) {
      if (other === process.platform) continue;
      const c = await detectLimitCapabilities(other);
      assert.deepEqual([c.processSampler, c.diskSampler], [false, false], other);
    }
    const here = await detectLimitCapabilities();
    if (process.platform === "linux") assert.equal(here.processSampler, undefined, "Linux uses the cgroup and rlimit mechanisms of A08b");
  });

  test("Linux is untouched by the sampling monitor", () => {
    const r = limitedPlan({ file: "bwrap", args: [], env: {} }, { memoryMb: 64 }, sampled("linux", { cgroupScope: true, processSampler: true, diskSampler: true }));
    assert.equal(r.watch, undefined);
    assert.equal(r.report[0]!.enforced, "full");
  });
});

describe("the sampling monitor: real runs through the launcher (this host's ps, standing in for macOS)", () => {
  const records: LaunchRecord[] = [];
  const caps = sampled("darwin", { processSampler: true, diskSampler: true });
  const make = async (extra: Partial<Parameters<typeof SandboxLauncher.create>[0]> = {}) => SandboxLauncher.create({ protectedPaths: [], audit: (x) => { records.push(x); }, platform: "darwin", trustedHost: { authority: "test" }, headroom: { cpus: 0, memoryMb: 0 }, limitCapabilities: caps, sampling: { intervalMs: 100, diskEveryMs: 100 }, ...extra });
  const go = async (launcher: SandboxLauncher, command: string[], limits: Parameters<SandboxLauncher["launch"]>[0]["limits"], r = recipe(), timeoutMs = 20_000) =>
    (await launcher.launch({ recipe: r, command, timeoutMs, maxOutputBytes: 10_000, ...(limits === undefined ? {} : { limits }) })).result;
  const node = process.execPath;

  test("a runaway in memory is ended at its limit and a modest one is not; the record says partial", async (t) => {
    if (process.platform === "win32") return t.skip("needs ps");
    const launcher = await make();
    const big = await go(launcher, [node, "-e", "const b = Buffer.alloc(400e6, 1); setTimeout(() => {}, 15000);"], { memoryMb: 200 });
    assert.equal(big.limitExceeded?.limit, "memoryMb", JSON.stringify(big));
    assert.ok(big.limitExceeded!.observed > 200 && big.durationMs < 12_000, `${big.durationMs} ms`);
    assert.ok(big.signal === "SIGKILL" || big.exitCode !== 0);
    assert.deepEqual(records.at(-1)!.limits.map((l) => [l.limit, l.enforced]), [["memoryMb", "partial"]]);
    const small = await go(launcher, [node, "-e", "setTimeout(() => {}, 800);"], { memoryMb: 600 });
    assert.equal(small.limitExceeded, undefined);
    assert.equal(small.exitCode, 0);
  });

  test("a memory runaway whose parent exited (handed to init) is still ended", async (t) => {
    if (process.platform === "win32") return t.skip("needs ps");
    const launcher = await make();
    const r = await go(launcher, ["/bin/sh", "-c", `(${node} -e 'const b = Buffer.alloc(400e6, 1); setTimeout(() => {}, 15000);' &) ; sleep 15`], { memoryMb: 200 });
    assert.equal(r.limitExceeded?.limit, "memoryMb", JSON.stringify(r));
    assert.ok(r.durationMs < 12_000, `${r.durationMs} ms`);
  });

  test("a fork storm is ended at its process limit", async (t) => {
    if (process.platform === "win32") return t.skip("needs ps");
    const launcher = await make();
    const r = await go(launcher, ["/bin/sh", "-c", "i=0; while [ $i -lt 30 ]; do sleep 20 & i=$((i+1)); done; wait"], { processes: 8 });
    assert.equal(r.limitExceeded?.limit, "processes", JSON.stringify(r));
    assert.ok(r.limitExceeded!.observed > 8);
    assert.ok(r.durationMs < 12_000);
    const ok = await go(launcher, ["/bin/sh", "-c", "sleep 0.5 & sleep 0.5 & wait"], { processes: 8 });
    assert.equal(ok.limitExceeded, undefined);
  });

  test("disk: writing past the limit under the checkout is ended; the checkout's existing files do not count", async (t) => {
    if (process.platform === "win32") return t.skip("needs ps");
    const launcher = await make();
    const r1 = recipe();
    writeFileSync(join(r1.workdir, "existing"), "e".repeat(8 * 1048576));
    const r = await go(launcher, ["/bin/sh", "-c", 'sleep 0.3; head -c 6000000 /dev/zero > "$PWD/big"; sleep 20'], { diskMb: 3 }, r1);
    assert.equal(r.limitExceeded?.limit, "diskMb", JSON.stringify(r));
    assert.ok(r.durationMs < 12_000);
    const fine = await go(launcher, ["/bin/sh", "-c", 'sleep 0.3; head -c 1000000 /dev/zero > "$PWD/small"; sleep 0.5'], { diskMb: 3 }, r1);
    assert.equal(fine.limitExceeded, undefined);
    assert.equal(fine.exitCode, 0);
  });

  test("a run using more CPU than its share is paced (paused and resumed) and nothing is left stopped", async (t) => {
    if (process.platform === "win32" || availableParallelism() < 2) return t.skip("needs ps and two cores");
    // The pacing needs the host to really give the two loops more than one core's worth; on a machine busy with other work it cannot be shown (the unit tests above hold the decision itself), so say so instead of failing.
    const probe = spawn("/bin/sh", ["-c", `${node} -e 'for(;;);' & ${node} -e 'for(;;);' & wait`], { stdio: "ignore" });
    const t0 = Date.now(); await sleep(1500);
    const seen = await psSampler()(probe.pid!);
    const cores = seen === undefined ? 0 : seen.cpuMs / (Date.now() - t0);
    try { execFileSync("pkill", ["-P", String(probe.pid)], { stdio: "ignore" }); } catch { /* none */ } probe.kill("SIGKILL");
    if (cores < 1.4) return t.skip(`this host gave two busy loops only ${cores.toFixed(2)} cores' worth just now`);
    const launcher = await make();
    const r = await go(launcher, ["/bin/sh", "-c", `${node} -e 'for(;;);' & ${node} -e 'for(;;);' & wait`], { cpus: 1 }, recipe(), 6000);
    assert.equal(r.timedOut, true);
    assert.ok((r.cpuPauses ?? 0) >= 1, `paused ${String(r.cpuPauses)} times`);
    assert.equal(r.limitExceeded, undefined, "pacing is not ending the run");
    await sleep(500);
    const left = execFileSync("ps", ["-A", "-o", "pid=,stat=,args="], { encoding: "utf8" }).split("\n").filter((l) => l.includes("for(;;);"));
    assert.deepEqual(left, [], "the paced processes were ended at the time limit, even though they were paused at times");
  });

  test("a launch that must be enforced in full is refused where only sampling exists, before anything runs", async () => {
    const launcher = await make();
    const before = records.length;
    await assert.rejects(() => launcher.launch({ recipe: recipe(), command: ["/bin/true"], timeoutMs: 5000, maxOutputBytes: 100, limits: { memoryMb: 64 }, requireEnforced: true }), /memoryMb/);
    assert.equal(records.length, before);
  });

  test("without limits, or with a watcher that has nothing to see, no monitor starts (injected sampler never asked)", async () => {
    let asked = 0;
    const launcher = await make({ usageSampler: async () => { asked++; return undefined; } });
    await go(launcher, ["/bin/sh", "-c", "sleep 0.5"], undefined);
    assert.equal(asked, 0);
    const none = await make({ limitCapabilities: sampled("darwin") });
    const r = await go(none, ["/bin/sh", "-c", "true"], { memoryMb: 64 });
    assert.equal(r.limitExceeded, undefined);
    assert.equal(r.cpuPauses, undefined);
  });

  test("an injected sampler decides: its figures end the run, and the result carries numbers only", async () => {
    const launcher = await make({ usageSampler: async () => sample({ rssMb: 9999, pids: [] }) });
    const r = await go(launcher, ["/bin/sh", "-c", "sleep 20"], { memoryMb: 64 });
    assert.deepEqual(r.limitExceeded, { limit: "memoryMb", value: 64, observed: 9999 });
    assert.ok(r.durationMs < 10_000);
  });
});
