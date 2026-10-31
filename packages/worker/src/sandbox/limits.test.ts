import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { SandboxError } from "./errors.js";
import { SandboxLauncher, type LaunchRecord } from "./launcher.js";
import { checkHeadroom, checkLimits, coreList, detectLimitCapabilities, limitedPlan, nextCoreOffset, type LimitCapabilities } from "./limits.js";
import type { SandboxRecipe } from "./recipe.js";

const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-limits-")));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const dir = (name: string): string => { const p = join(root, name); mkdirSync(p, { recursive: true }); return p; };
const recipe = (): SandboxRecipe => { const n = ++counter; return { mode: "sandboxed", workdir: dir(`w${n}`), home: dir(`h${n}`), scratch: dir(`s${n}`), readOnly: [], network: "none", env: {}, protectedSubpaths: [] }; };

const base = { file: "bwrap", args: ["--x", "--", "/bin/sh"], env: {} };
const caps = (extra: Partial<LimitCapabilities>): LimitCapabilities => ({ platform: "linux", cgroupScope: false, escapeDollar: true, prlimit: false, taskset: false, passEnv: { XDG_RUNTIME_DIR: "/run/user/1000" }, ...extra });

describe("resource limits: the plan", () => {
  test("limits are validated and may not take the controller's share of the machine", () => {
    assert.deepEqual(checkLimits({ cpus: 2, memoryMb: 512 }), { cpus: 2, memoryMb: 512 });
    for (const bad of [null, [], { cpus: 0 }, { cpus: 1.5 }, { memoryMb: -1 }, { disk: 5 }, { processes: 1e9 }, { diskMb: "5" }]) assert.throws(() => checkLimits(bad), SandboxError, JSON.stringify(bad));
    assert.doesNotThrow(() => checkHeadroom({ cpus: 3, memoryMb: 3000 }, { cpus: 1, memoryMb: 1024 }, { cpus: 4, memoryMb: 4096 }));
    assert.throws(() => checkHeadroom({ cpus: 4 }, { cpus: 1, memoryMb: 1024 }, { cpus: 4, memoryMb: 4096 }), /only 3 of 4 are left/);
    assert.throws(() => checkHeadroom({ memoryMb: 4000 }, { cpus: 1, memoryMb: 1024 }, { cpus: 4, memoryMb: 4096 }), /only 3072 of 4096 are left/);
  });

  test("with a user systemd scope every limit but disk is enforced in full by the cgroup; disk is reported as partial", () => {
    const { plan, report } = limitedPlan(base, { cpus: 2, memoryMb: 256, processes: 50, diskMb: 100 }, caps({ cgroupScope: true, prlimit: true }));
    assert.deepEqual(report.map((r) => [r.limit, r.enforced]), [["cpus", "full"], ["diskMb", "partial"], ["memoryMb", "full"], ["processes", "full"]]);
    assert.equal(plan.file, "systemd-run");
    assert.deepEqual(plan.args.slice(0, 4), ["--user", "--scope", "--quiet", "--collect"]);
    for (const p of ["CPUQuota=200%", "MemoryMax=256M", "MemorySwapMax=0", "TasksMax=50"]) assert.ok(plan.args.includes(p), p);
    assert.ok(plan.args.some((a) => a === "--fsize=104857600"));
    assert.equal(plan.env["XDG_RUNTIME_DIR"], "/run/user/1000");
    assert.deepEqual(plan.args.slice(-3), ["--x", "--", "/bin/sh"]);
    // A dollar sign in the command reaches the program as written (systemd would otherwise expand it).
    const dollars = limitedPlan({ ...base, args: ["-c", "echo ${#x} $i"] }, { memoryMb: 64 }, caps({ cgroupScope: true }));
    assert.equal(dollars.plan.args.at(-1), "echo $${#x} $$i");
    // Where this systemd passes the line through as written, nothing is doubled.
    assert.equal(limitedPlan({ ...base, args: ["-c", "echo ${#x} $i"] }, { memoryMb: 64 }, caps({ cgroupScope: true, escapeDollar: false })).plan.args.at(-1), "echo ${#x} $i");
  });

  test("without one: memory falls back to an address-space cap, cpus to an affinity mask, and the process count is reported as not enforced", () => {
    const { plan, report } = limitedPlan(base, { cpus: 2, memoryMb: 256, processes: 50 }, caps({ prlimit: true, taskset: true }));
    assert.deepEqual(report.map((r) => [r.limit, r.enforced, r.by]), [["cpus", "partial", "CPU affinity mask (taskset)"], ["memoryMb", "partial", "RLIMIT_AS"], ["processes", "none", undefined]]);
    assert.match(report[2]!.detail, /RLIMIT_NPROC counts all/);
    assert.equal(plan.file, "taskset");
    assert.deepEqual(plan.args.slice(0, 3), ["-c", "0,1", "prlimit"]);
    assert.match(report[0]!.detail, /can widen its own affinity/, "a pin is a request, not a quota");
  });

  test("the translated command lines are exactly what the mechanisms need (systemd-run units, prlimit options, taskset list)", () => {
    const scope = limitedPlan(base, { cpus: 2, memoryMb: 256, processes: 50 }, caps({ cgroupScope: true, escapeDollar: false }));
    assert.equal(scope.plan.file, "systemd-run");
    assert.deepEqual(scope.plan.args, ["--user", "--scope", "--quiet", "--collect", "-p", "CPUQuota=200%", "-p", "MemoryMax=256M", "-p", "MemorySwapMax=0", "-p", "TasksMax=50", "--", "bwrap", "--x", "--", "/bin/sh"]);
    assert.deepEqual(scope.plan.env, { XDG_RUNTIME_DIR: "/run/user/1000", PATH: "/usr/bin:/bin" });
    const fallback = limitedPlan(base, { cpus: 2, memoryMb: 256, diskMb: 10 }, caps({ prlimit: true, taskset: true }), { coreOffset: 1, cores: 4 });
    assert.equal(fallback.plan.file, "taskset");
    assert.deepEqual(fallback.plan.args, ["-c", "1,2", "prlimit", `--fsize=${10 * 1048576}`, `--as=${256 * 1048576}`, "--", "bwrap", "--x", "--", "/bin/sh"]);
    assert.equal(fallback.report.find((r) => r.limit === "diskMb")!.enforced, "partial");
    // wallTimeMs is the launcher's time limit: it adds nothing to the command line and is not in the plan's report.
    assert.deepEqual(limitedPlan(base, { wallTimeMs: 5000 }, caps({ cgroupScope: true })), { plan: base, report: [] });
    assert.deepEqual(checkLimits({ wallTimeMs: 5000 }), { wallTimeMs: 5000 });
    assert.throws(() => checkLimits({ wallTimeMs: 10 }), SandboxError);
  });

  test("the pinned cores rotate from launch to launch and wrap, so agents do not all share cores 0..n-1", () => {
    assert.deepEqual(coreList(2, 0, 4), [0, 1]);
    assert.deepEqual(coreList(2, 3, 4), [0, 3], "wraps around the machine");
    assert.deepEqual(coreList(8, 1, 4), [0, 1, 2, 3], "asking for every core pins to all of them");
    const first = nextCoreOffset(2, 4), second = nextCoreOffset(2, 4), third = nextCoreOffset(2, 4);
    assert.deepEqual([second, third], [(first + 2) % 4, first], "each launch starts after the previous pin");
    assert.notEqual(first, second);
  });

  test("a host with nothing reports every limit as not enforced and leaves the plan alone; other systems the same", () => {
    const none = limitedPlan(base, { cpus: 1, memoryMb: 64, diskMb: 10, processes: 5 }, caps({}));
    assert.deepEqual(none.report.map((r) => r.enforced), ["none", "none", "none", "none"]);
    assert.deepEqual(none.plan, base);
    for (const platform of ["darwin", "win32"] as const) {
      const r = limitedPlan(base, { memoryMb: 64 }, caps({ platform }));
      assert.deepEqual([r.report[0]!.enforced, r.plan], ["none", base]);
      assert.match(r.report[0]!.detail, new RegExp(platform));
    }
    assert.deepEqual(limitedPlan(base, {}, caps({ cgroupScope: true })), { plan: base, report: [] });
    // Windows and macOS: every named limit is reported as not enforced (never silently skipped) and the plan is untouched, so a strict launch refuses there.
    for (const platform of ["darwin", "win32"] as const) {
      const r = limitedPlan(base, { cpus: 1, memoryMb: 64, diskMb: 10, processes: 5 }, caps({ platform, cgroupScope: true, prlimit: true, taskset: true }));
      assert.deepEqual(r.report.map((x) => [x.limit, x.enforced]), [["cpus", "none"], ["diskMb", "none"], ["memoryMb", "none"], ["processes", "none"]], platform);
      assert.deepEqual(r.plan, base, platform);
    }
  });
});

describe("resource limits: real processes (Linux)", () => {
  const records: LaunchRecord[] = [];
  const sh = async (launcher: SandboxLauncher, script: string, limits: Parameters<SandboxLauncher["launch"]>[0]["limits"], r = recipe(), requireEnforced = false) =>
    (await launcher.launch({ recipe: r, command: ["/bin/sh", "-c", script], timeoutMs: 30_000, maxOutputBytes: 100_000, ...(limits === undefined ? {} : { limits }), requireEnforced })).result;
  const make = async (limitCapabilities?: LimitCapabilities) => SandboxLauncher.create({ protectedPaths: [], audit: (x) => { records.push(x); }, headroom: { cpus: 0, memoryMb: 0 }, ...(limitCapabilities === undefined ? {} : { limitCapabilities }) });
  const ifLinux = (name: string, fn: (launcher: SandboxLauncher) => Promise<void>, wanted?: () => Promise<LimitCapabilities>): void => {
    test(name, async (t) => {
      if (process.platform !== "linux") return t.skip("Linux only");
      const launcher = await make(wanted === undefined ? undefined : await wanted());
      if (!launcher.capacity.available) { if (required) assert.fail(`the sandbox is required but unusable: ${launcher.capacity.reason}`); return t.skip(`bubblewrap unusable: ${launcher.capacity.reason}`); }
      await fn(launcher);
    });
  };
  const fallback = async (): Promise<LimitCapabilities> => { const c = await detectLimitCapabilities(); return { ...c, cgroupScope: false }; };

  ifLinux("each launch records which limits were enforced and by what", async (launcher) => {
    const before = records.length;
    await sh(launcher, "true", { memoryMb: 512, diskMb: 50, processes: 100 });
    const rec = records[before]!;
    assert.deepEqual(rec.limits.map((l) => l.limit), ["diskMb", "memoryMb", "processes"]);
    assert.ok(rec.limits.every((l) => ["full", "partial", "none"].includes(l.enforced) && l.detail.length > 0));
    const none = records.length; await sh(launcher, "true", undefined);
    assert.deepEqual(records[none]!.limits, []);
  });

  ifLinux("requireEnforced refuses a launch whose limit cannot be enforced in full, before anything runs", async (launcher) => {
    const before = records.length;
    await assert.rejects(() => sh(launcher, "echo ran", { processes: 10 }, recipe(), true), (e: unknown) => e instanceof SandboxError && e.code === "unavailable" && /processes/.test(e.message));
    assert.equal(records.length, before, "nothing was recorded or run");
  }, async () => caps({ platform: process.platform }));

  ifLinux("a launch that asks for more than is left after the headroom is refused", async () => {
    const strict = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined, headroom: { cpus: 1000, memoryMb: 0 } });
    if (!strict.capacity.available) return;
    await assert.rejects(() => strict.launch({ recipe: recipe(), command: ["/bin/true"], timeoutMs: 5000, maxOutputBytes: 100, limits: { cpus: 1 } }), /left after/);
  });

  ifLinux("memory: the process cannot take more than its limit (cgroup when there is one)", async (launcher) => {
    const big = await sh(launcher, 'x=$(head -c 300000000 /dev/zero | tr "\\0" a); echo done ${#x}', { memoryMb: 128 });
    assert.ok(big.exitCode !== 0 || !big.stdout.includes("done 300000000"), `ran to completion: ${big.stdout.slice(0, 80)} ${big.stderr.slice(0, 120)}`);
    const small = await sh(launcher, 'x=$(head -c 1000000 /dev/zero | tr "\\0" a); echo done ${#x}', { memoryMb: 128 });
    assert.equal(small.stdout.trim(), "done 1000000", small.stderr);
  });

  ifLinux("memory: the address-space cap works where there is no cgroup scope", async (launcher) => {
    const big = await sh(launcher, 'x=$(head -c 300000000 /dev/zero | tr "\\0" a); echo done ${#x}', { memoryMb: 128 });
    assert.ok(big.exitCode !== 0 || !big.stdout.includes("done 300000000"), big.stdout.slice(0, 80));
  }, fallback);

  ifLinux("disk: no single file grows past the cap", async (launcher) => {
    const r = recipe();
    const out = await sh(launcher, "head -c 5000000 /dev/zero > /scratch/big; echo end", { diskMb: 1 }, r);
    const size = readdirSync(r.scratch).includes("big") ? statSync(join(r.scratch, "big")).size : 0;
    assert.ok(size <= 1048576, `wrote ${size} bytes (${out.stderr.slice(0, 80)})`);
  }, fallback);

  ifLinux("processes: the group cannot hold more than the limit (cgroup)", async (launcher) => {
    if (!launcher.capacity.available) return;
    const out = await sh(launcher, 'for i in $(seq 1 40); do sleep 3 & done 2>/dev/null; ls /proc | grep -c "^[0-9]"', { processes: 12 });
    // Without a user systemd scope (a CI container, say) the limit is reported as not enforced instead, which is also what must be on the record.
    if (records.at(-1)!.limits[0]!.enforced === "none") return;
    assert.ok(Number(out.stdout.trim().split("\n").pop()) <= 12, `${out.stdout} ${out.stderr.slice(0, 100)}`);
  }, async () => { const c = await detectLimitCapabilities(); return c.cgroupScope ? c : caps({ platform: "linux", cgroupScope: false, escapeDollar: false }); });

  ifLinux("cpus: the affinity mask leaves the process one core (where there is no cgroup scope)", async (launcher) => {
    const out = await sh(launcher, "grep Cpus_allowed_list /proc/self/status", { cpus: 1 });
    assert.match(out.stdout, /Cpus_allowed_list:\s+\d+\s*$/m, "pinned to exactly one core (which one rotates)");
  }, fallback);
});
