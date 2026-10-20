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

// The same crash matrix as the in-thread adapter's (qualification.test.ts): the whole process is killed from inside the worker thread
// immediately before and after every numbered statement of a write, and a fresh connection must see all of it or none of it.
const rig: BoundaryRig = {
  name: "sqlite (worker thread)",
  open: async () => {
    const dir = mkdtempSync(join(tmpdir(), "nn sqlite-worker-boundary-"));
    const path = join(dir, "controller.sqlite");
    const view = await SqliteStorage.open({ path });
    return {
      view,
      attempt: (action, point: CrashPoint | undefined) => new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, ["--import", guard, child, "boundary-worker", path, point?.when ?? "none", point === undefined ? "none" : String(point.ordinal), action], { stdio: ["ignore", "pipe", "inherit"] });
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

for (const [action, expected] of [["operation", 30], ["claim", 6], ["epoch", 4], ["retry", 5]] as const) {
  test(`SQLite worker thread: a process killed before or after every statement of ${action === "operation" ? "a complex operation" : `a ${action}`} leaves either all of it or none of it, and it is durable exactly when COMMIT has run`, async (t) => {
    const report = await runBoundaryQualification(rig, action);
    t.diagnostic(`crash matrix (${action}): ${report.statements} statements, ${report.points} crash points, committed only at: ${report.committedPoints.join(", ")}`);
    assert.equal(report.statements, expected, "the worker runs the same statements as the in-thread adapter");
    assert.deepEqual(report.committedPoints, [`after ${report.statements}`]);
  });
}
