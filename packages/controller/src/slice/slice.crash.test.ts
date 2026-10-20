import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { SqliteStorage } from "../storage/sqlite/index.js";
import { Chaos } from "./chaos.js";
import { Clock, check, runPath, signature, startProcess, type SliceWorld } from "./pipeline.js";

const child = fileURLToPath(new URL("./child.js", import.meta.url));
const guard = pathToFileURL(fileURLToPath(new URL("../../../../scripts/offline-guard.mjs", import.meta.url))).href;

function run(directory: string, crashAt: number): Promise<{ killed: boolean; out: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", guard, child, directory, String(crashAt)], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("error", reject);
    proc.on("exit", (code, signal) => resolve({ killed: signal !== null || code !== 0, out }));
  });
}

async function finishAndCheck(directory: string, crashLabel?: string): Promise<{ problems: string[]; signature: string; labels: string[] }> {
  const storage = await SqliteStorage.open({ path: join(directory, "db.sqlite") });
  try {
    const chaos = new Chaos();
    const clock = new Clock();
    clock.advance(10 * 60_000); // the restart takes a while: the dead process's leases are over
    const sw: SliceWorld = { storage, directory, chaos, clock: clock.now };
    const slice = await startProcess(sw, "restarted");
    await runPath(slice);
    return { problems: await check(slice, sw, crashLabel), signature: await signature(sw), labels: chaos.labels };
  } finally { await storage.close(); }
}

test("the path survives a real SIGKILL at boundaries spread over the whole run, and the recovered state equals the clean run", async () => {
  const cleanDir = mkdtempSync(join(tmpdir(), "nn slice-clean-"));
  let clean: { problems: string[]; signature: string; labels: string[] };
  try {
    const first = await run(cleanDir, 1_000_000);
    assert.equal(first.out.includes("finished"), true, "the clean run finishes");
    clean = await finishAndCheck(cleanDir); // restarting a finished run changes nothing
    assert.deepEqual(clean.problems, []);
  } finally { rmSync(cleanDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }

  // How many boundaries a run has: count them in a run that is not killed.
  const countDir = mkdtempSync(join(tmpdir(), "nn slice-count-"));
  let boundaries: number;
  let countedLabels: string[] = [];
  try {
    const storage = await SqliteStorage.open({ path: join(countDir, "db.sqlite") });
    const chaos = new Chaos();
    const clock = new Clock();
    await runPath(await startProcess({ storage, directory: countDir, chaos, clock: clock.now }, "counter"));
    boundaries = chaos.labels.length;
    countedLabels = [...chaos.labels];
    await storage.close();
  } finally { rmSync(countDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  assert.ok(boundaries >= 40);

  const points = [0, 1, 7, 19, 33, Math.floor(boundaries / 2), 71, 72, boundaries - 4, boundaries - 1].filter((p, i, all) => p < boundaries && all.indexOf(p) === i);
  const failures: string[] = [];
  for (const point of points) {
    const dir = mkdtempSync(join(tmpdir(), "nn slice-kill-"));
    try {
      const killed = await run(dir, point);
      if (!killed.killed || killed.out.includes("finished")) { failures.push(`${point}: the child was not killed`); continue; }
      const recovered = await finishAndCheck(dir, countedLabels[point]);
      if (recovered.problems.length > 0) failures.push(`${point}: ${recovered.problems.join("; ")}`);
      else if (recovered.signature !== clean.signature) failures.push(`${point}: the recovered state differs from the clean run`);
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }
  assert.deepEqual(failures, []);
  console.log(`# slice real kills: ${points.length} of ${boundaries} boundaries (SIGKILL), restarted and verified`);
});
