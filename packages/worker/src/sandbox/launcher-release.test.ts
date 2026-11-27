import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { BackendHealth, SandboxBackend, SpawnPlan } from "./backend.js";
import { SandboxLauncher, stripTrailingSeparator, type LaunchRecord } from "./launcher.js";

// The launcher's side of a backend that reports details and releases what it set up after each run (the native Windows backend does both: windows-native.ts `auditDetails`, `release`).
// Moved from windows.test.ts when the Windows Sandbox backend was removed (owner decision 2026-11-26); the stand-in backend runs a harmless local program, so these run on any OS.
describe("the launcher with a backend that reports details and releases after each run", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-lrel-")));
  after(() => rmSync(root, { recursive: true, force: true }));
  const dir = (name: string): string => { const p = join(root, name); mkdirSync(p, { recursive: true }); return p; };

  const planned: (string | undefined)[] = [];
  let failRelease = false;
  function stub(health: BackendHealth, released: SpawnPlan[], script = "process.exit(0)"): SandboxBackend {
    return {
      name: "stand-in",
      health: async () => health,
      plan: (_r, _c, runId) => { planned.push(runId); return { file: process.execPath, args: ["-e", script], env: { NN_STAND_IN_JOB: "job-1" } }; },
      guestView: (r) => ({ workdir: "C:\\nn\\work", home: "C:\\nn\\home", scratch: "C:\\nn\\scratch", tmp: "C:\\nn\\scratch\\.tmp", inputs: r.readOnly.map((m) => ({ host: m.host, guest: m.guest })) }),
      auditDetails: () => ({ mode: "stand-in-mode", sessionDependent: "true" }),
      release: async (plan) => { released.push(plan); if (failRelease) throw new Error("cleanup left something behind"); },
    };
  }
  const request = (extra = "") => ({ recipe: { mode: "sandboxed" as const, workdir: dir(`w${extra}`), home: dir(`h${extra}`), scratch: dir(`s${extra}`), readOnly: [], network: "none" as const, env: {}, protectedSubpaths: [] }, command: ["/work/x.exe"], timeoutMs: 20_000, maxOutputBytes: 10_000 });

  test("the launch record carries the backend's mode details, the capacity carries its notes, and release runs after the run", async () => {
    const records: LaunchRecord[] = []; const released: SpawnPlan[] = [];
    const launcher = await SandboxLauncher.create({ backend: stub({ healthy: true, backend: "stand-in", version: "1.0", notes: ["session-dependent: x"] }, released), protectedPaths: [], audit: (r) => { records.push(r); } });
    assert.equal(launcher.capacity.available, true);
    assert.deepEqual(launcher.capacity.notes, ["session-dependent: x"]);
    const run = await launcher.launch(request("1"));
    await run.result;
    assert.deepEqual(records[0]!.backendDetails, { mode: "stand-in-mode", sessionDependent: "true" });
    assert.equal(records[0]!.backend, "stand-in");
    assert.equal(records[0]!.mode, "sandboxed");
    assert.equal(released.length, 1);
    assert.equal(released[0]!.env["NN_STAND_IN_JOB"], "job-1");
  });

  test("both plans of one launch get the launch's run id, and a release that fails is reported in the result", async () => {
    const released: SpawnPlan[] = [];
    const launcher = await SandboxLauncher.create({ backend: stub({ healthy: true, backend: "stand-in" }, released), protectedPaths: [], audit: () => undefined });
    planned.length = 0;
    const a = await launcher.launch(request("4"));
    const b = await launcher.launch(request("5"));
    assert.equal(planned.length, 4);
    assert.equal(planned[0], a.runId); assert.equal(planned[1], a.runId);
    assert.equal(planned[2], b.runId); assert.equal(planned[3], b.runId);
    assert.notEqual(a.runId, b.runId);
    await Promise.all([a.result, b.result]);
    failRelease = true;
    try {
      const c = await launcher.launch(request("6"));
      assert.equal((await c.result).releaseProblem, "cleanup left something behind");
    } finally { failRelease = false; }
  });

  test("the supervisor root loses a trailing separator of either kind", () => {
    assert.equal(stripTrailingSeparator("C:\\repo\\packages\\worker\\"), "C:\\repo\\packages\\worker");
    assert.equal(stripTrailingSeparator("/repo/packages/worker/"), "/repo/packages/worker");
    assert.equal(stripTrailingSeparator("/repo/packages/worker"), "/repo/packages/worker");
  });

  test("a killed run is released too, and an unhealthy backend gives no capacity, no launch and its notes", async () => {
    const released: SpawnPlan[] = [];
    const launcher = await SandboxLauncher.create({ backend: stub({ healthy: true, backend: "stand-in" }, released, "setInterval(() => {}, 1000)"), protectedPaths: [], audit: () => undefined });
    const run = await launcher.launch(request("2"));
    run.kill();
    const result = await run.result;
    assert.equal(result.killed, true);
    assert.equal(released.length, 1);
    const down = await SandboxLauncher.create({ backend: stub({ healthy: false, backend: "stand-in", reason: "nobody is signed in", notes: ["session-dependent: y"] }, released), protectedPaths: [], audit: () => undefined });
    assert.equal(down.capacity.available, false);
    assert.deepEqual(down.capacity.notes, ["session-dependent: y"]);
    await assert.rejects(down.launch(request("3")), /no confined launch is possible: nobody is signed in/);
    assert.equal(released.length, 1);
  });
});
