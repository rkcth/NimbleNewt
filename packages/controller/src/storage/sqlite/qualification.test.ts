import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { runBoundaryQualification, type BoundaryRig, type CrashPoint } from "../qualification/boundaries.js";
import { SqliteStorage } from "./index.js";

const child = fileURLToPath(new URL("./testing/child.js", import.meta.url));
const guard = pathToFileURL(fileURLToPath(new URL("../../../../../scripts/offline-guard.mjs", import.meta.url))).href;

const rig: BoundaryRig = {
  name: "sqlite",
  open: async () => {
    const dir = mkdtempSync(join(tmpdir(), "nn sqlite-boundary-"));
    const path = join(dir, "controller.sqlite");
    const view = await SqliteStorage.open({ path });
    return {
      view,
      attempt: (action, point: CrashPoint | undefined) => new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, ["--import", guard, child, "boundary", path, point?.when ?? "none", point === undefined ? "none" : String(point.ordinal), action], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        proc.on("error", reject);
        proc.on("exit", () => {
          const done = /completed (\d+)/.exec(out);
          resolve({ crashed: done === null, statements: done === null ? 0 : Number(done[1]) });
        });
      }),
      close: async () => { await view.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); },
    };
  },
};

for (const action of ["operation", "claim", "epoch", "retry"] as const) {
  test(`SQLite: a writer killed before or after every statement of ${action === "operation" ? "a complex operation" : `a ${action}`} leaves either all of it or none of it, and it is durable exactly when COMMIT has run`, async (t) => {
    const report = await runBoundaryQualification(rig, action);
    t.diagnostic(`crash matrix (${action}): ${report.statements} statements, ${report.points} crash points (before and after each), committed only at: ${report.committedPoints.join(", ")}`);
    assert.ok(report.points >= (action === "operation" ? 40 : 6), `only ${report.points} crash points were exercised`);
    assert.deepEqual(report.committedPoints, [`after ${report.statements}`]);
  });
}
