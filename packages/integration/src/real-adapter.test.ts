import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { SqliteStorage } from "@nimblenewt/controller";
import * as sliceHarness from "@nimblenewt/controller/testing";
import { openAdapter, piConversation } from "./conversation.js";

const { ANSWER, Chaos, Clock, check, runPath, signature, startProcess } = sliceHarness;
const child = fileURLToPath(new URL("./real-child.js", import.meta.url));
const guard = pathToFileURL(fileURLToPath(new URL("../../../scripts/offline-guard.mjs", import.meta.url))).href;

function run(directory: string, crashAt: number): Promise<{ killed: boolean; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", guard, child, directory, String(crashAt)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("error", reject);
    proc.on("exit", (code, signal) => resolve({ killed: signal !== null || code !== 0, out, err }));
  });
}

/** The restarted process: reopens the controller's database and Pi's durable storage, and runs the same path to completion. */
async function finish(directory: string, crashLabel?: string) {
  const storage = await SqliteStorage.open({ path: join(directory, "db.sqlite") });
  const { adapter } = await openAdapter(join(directory, "pi"), ANSWER);
  try {
    const clock = new Clock();
    clock.advance(10 * 60_000);
    let resumed = 0;
    const world = { storage, directory, chaos: new Chaos(), clock: clock.now, conversation: () => { const c = piConversation(adapter); return { ...c, recover: async (reason: string) => { resumed += 1; await c.recover!(reason); } }; } };
    const slice = await startProcess(world, "restarted");
    await runPath(slice);
    const problems = await check(slice, world, crashLabel);
    // The model answered once: the transcript holds the answer exactly once, however many times the request was submitted.
    const answers = (await adapter.root().transcript()).filter((e) => e.text === ANSWER).length;
    if (answers !== 1) problems.push(`the transcript holds the model's answer ${answers} time(s)`);
    // And the task's text reached the model exactly once as a user message.
    const inputs = (await adapter.root().transcript()).filter((e) => e.role === "user" && e.text.includes("Order seeds")).length;
    if (inputs !== 1) problems.push(`the transcript holds the task as ${inputs} user message(s)`);
    // The checkpoint kept in the controller's recovery point is one the runtime accepts.
    const point = await slice.recovery.forAttempt(slice.ids.attemptId);
    const verdict = point?.checkpoint === undefined ? undefined : await adapter.root().verifyCheckpoint(point.checkpoint as never);
    if (verdict?.valid !== true) problems.push(`the recovery point's checkpoint is not valid: ${JSON.stringify(verdict)}`);
    return { problems, signature: await signature(world), resumed };
  } finally {
    await adapter.close();
    await storage.close();
  }
}

test("the whole path with the real Pi adapter survives a real SIGKILL at boundaries spread over the run, including with the model's request in flight", async () => {
  // A clean run, to count the boundaries and to have something to compare with.
  const cleanDir = mkdtempSync(join(tmpdir(), "nn real-clean-"));
  let labels: string[];
  let cleanSignature: string;
  try {
    const storage = await SqliteStorage.open({ path: join(cleanDir, "db.sqlite") });
    const { adapter } = await openAdapter(join(cleanDir, "pi"), ANSWER);
    const chaos = new Chaos();
    const clock = new Clock();
    const world = { storage, directory: cleanDir, chaos, clock: clock.now, conversation: () => piConversation(adapter) };
    const slice = await startProcess(world, "clean");
    await runPath(slice);
    assert.deepEqual(await check(slice, world), []);
    labels = [...chaos.labels];
    cleanSignature = await signature(world);
    await adapter.close();
    await storage.close();
  } finally { rmSync(cleanDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }

  // The boundaries around the model request (the bridge's), plus a spread over the rest.
  const bridge = labels.map((l, i) => (l.startsWith("bridge:") ? i : -1)).filter((i) => i >= 0);
  assert.equal(bridge.length, 3, "the bridge exposes its three boundaries on a clean run");
  const spread = labels.map((_, i) => i).filter((i) => i % 9 === 0);
  const points = [...new Set([...bridge, ...spread, labels.length - 1])].sort((a, b) => a - b);
  const failures: string[] = [];
  for (const point of points) {
    const dir = mkdtempSync(join(tmpdir(), "nn real-kill-"));
    try {
      const killed = await run(dir, point);
      if (!killed.killed || killed.out.includes("finished")) { failures.push(`${point} (${labels[point]}): the child was not killed (${killed.err.slice(0, 300)})`); continue; }
      const recovered = await finish(dir, labels[point]);
      if (point === bridge[1] && recovered.resumed === 0) failures.push(`${point}: the request was in flight when the process was killed, yet the restart found no interrupted work to resume`);
      if (recovered.problems.length > 0) failures.push(`${point} (${labels[point]}): ${recovered.problems.join("; ")}`);
      else if (recovered.signature !== cleanSignature) failures.push(`${point} (${labels[point]}): the recovered state differs from the clean run`);
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }
  assert.deepEqual(failures, []);
  console.log(`# real adapter: ${points.length} of ${labels.length} boundaries (SIGKILL), restarted and verified; the model request was in flight at boundary ${bridge[1]}`);
});
