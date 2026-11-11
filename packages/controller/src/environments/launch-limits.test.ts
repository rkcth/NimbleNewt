import assert from "node:assert/strict";
import { test } from "node:test";
import { LaunchLimitError, effectiveLaunchLimits, tightenLimits } from "./index.js";

// Card A08d: the effective limits of a launch. Pure; the storage-backed parts are in environments.test.ts and dispatch/launch-limits.test.ts.

test("the smaller figure wins, a figure only one side states is kept, and nothing states nothing", () => {
  assert.deepEqual(effectiveLaunchLimits({}), { limits: {}, sources: {}, capped: [] });
  const r = effectiveLaunchLimits({ environment: { cpus: 2, memoryMb: 512, diskMb: 100 }, installation: { cpus: 4, memoryMb: 256, processes: 50, wallTimeMs: 60_000 } });
  assert.deepEqual(r.limits, { cpus: 2, memoryMb: 256, diskMb: 100, processes: 50, wallTimeMs: 60_000 });
  assert.deepEqual(r.sources, { cpus: "environment", memoryMb: "installation", diskMb: "environment", processes: "installation", wallTimeMs: "installation" });
  assert.deepEqual(r.capped, [{ limit: "memoryMb", asked: 512, applied: 256 }]);
});

test("equal figures are the installation's and are not a cut; an environment alone is its own; only the installation alone is the installation's", () => {
  const r = effectiveLaunchLimits({ environment: { cpus: 2 }, installation: { cpus: 2 } });
  assert.deepEqual([r.sources, r.capped], [{ cpus: "installation" }, []]);
  assert.deepEqual(effectiveLaunchLimits({ environment: { cpus: 2 } }).sources, { cpus: "environment" });
  assert.deepEqual(effectiveLaunchLimits({ installation: { cpus: 2 } }).sources, { cpus: "installation" });
});

test("an environment can never raise a limit, whatever it states", () => {
  for (const [env, inst] of [[{ cpus: 256 }, { cpus: 1 }], [{ wallTimeMs: 604_800_000 }, { wallTimeMs: 1000 }], [{ memoryMb: 4_194_304 }, { memoryMb: 16 }]] as const) {
    const r = effectiveLaunchLimits({ environment: env, installation: inst });
    for (const [k, v] of Object.entries(inst)) assert.equal((r.limits as Record<string, number>)[k], v);
  }
});

test("every figure of either side is checked: type, whole number, bounds, NaN, infinity, huge, unknown name, shape; the message names the side, the figure and its unit", () => {
  const bad: unknown[] = [{ cpus: 0 }, { cpus: 257 }, { cpus: 1.5 }, { cpus: -1 }, { cpus: "2" }, { cpus: Number.NaN }, { cpus: Infinity }, { cpus: null }, { memoryMb: 15 }, { memoryMb: 4_194_305 }, { memoryMb: Number.MAX_SAFE_INTEGER + 2 },
    { diskMb: 16_777_217 }, { processes: 100_001 }, { wallTimeMs: 999 }, { wallTimeMs: 604_800_001 }, { wallTimeMs: 1e21 }, { gpus: 1 }, "x", 5, [], [1], null];
  for (const side of ["environment", "installation"] as const) {
    for (const value of bad) {
      const other = side === "environment" ? "installation" : "environment";
      assert.throws(() => effectiveLaunchLimits({ [side]: value, [other]: { cpus: 1 } }), (e: unknown) => e instanceof LaunchLimitError && new RegExp(`the ${side}'s limits`).test(e.message), `${side} ${String(JSON.stringify(value))}`);
    }
  }
  assert.throws(() => effectiveLaunchLimits({ environment: { wallTimeMs: 5 } }), /wallTimeMs must be a whole number from 1000 to 604800000 \(milliseconds\)/);
  assert.throws(() => effectiveLaunchLimits({ installation: { memoryMb: 1e12 } }), /memoryMb must be a whole number from 16 to 4194304 \(megabytes\)/);
});

test("undefined figures are skipped, an empty object is no limits, and the inputs are not changed", () => {
  const env = Object.freeze({ cpus: 2, memoryMb: undefined });
  assert.deepEqual(effectiveLaunchLimits({ environment: env, installation: {} }).limits, { cpus: 2 });
  assert.deepEqual(effectiveLaunchLimits({ environment: undefined, installation: undefined }).limits, {});
});

test("tightenLimits is the same rule without sources and checks both sides", () => {
  assert.equal(tightenLimits(undefined, undefined), undefined);
  assert.deepEqual(tightenLimits({ cpus: 4 }, undefined), { cpus: 4 });
  assert.deepEqual(tightenLimits({ cpus: 4, diskMb: 9 }, { cpus: 2, processes: 7 }), { cpus: 2, diskMb: 9, processes: 7 });
  assert.throws(() => tightenLimits({ cpus: 4 }, { cpus: 0 }), LaunchLimitError);
  assert.throws(() => tightenLimits({ cpus: Number.NaN }, { cpus: 1 }), LaunchLimitError);
});
