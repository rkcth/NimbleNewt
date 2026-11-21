/**
 * Child process for card G04. Usage: node g04-child.js <store spec JSON> <directory> <crashAt> <scenario>. Runs the whole path of the controller slice
 * (scenario `path`, or `wait`, see g04-wait.ts, or `tool`, see g04-tool.ts) over the given real database with the REAL Pi adapter (durable JSONL storage in <directory>/pi) in the same
 * process, and kills itself with SIGKILL at boundary <crashAt>.
 */
import { writeSync } from "node:fs";
import { join } from "node:path";
import { ANSWER, Chaos, Clock, KILLED_AT, openAdapter, openStore, piConversation, runPath, startProcess, type StoreSpec } from "./g04-fixture.js";
import { childToolRun } from "./g04-tool.js";
import { waitScenario } from "./g04-wait.js";

const [specJson, directory, crashAt, scenario] = process.argv.slice(2) as [string, string, string, string];
/**
 * Writes all of `data` to `fd` synchronously. Once Node has opened stderr as a stream, a pipe on POSIX is non-blocking and a full one answers EAGAIN
 * (or takes only part): the rest goes out in pieces, waiting 1 ms while the parent reads.
 */
function writeAll(fd: number, data: string): void {
  const bytes = Buffer.from(data);
  for (let sent = 0; sent < bytes.length;) {
    try { sent += writeSync(fd, bytes, sent, Math.min(16_384, bytes.length - sent)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
}
// Every label the process passed, ending with the one it dies at, goes to stderr first (synchronously), so the parent can check the kill landed on the
// boundary it meant, after the same steps as the uncrashed run (killProblem).
const chaos: InstanceType<typeof Chaos> = new Chaos(Number(crashAt), () => (writeAll(2, `${KILLED_AT}${JSON.stringify(chaos.labels)}\n`), process.kill(process.pid, "SIGKILL"), Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)));
// Harness probes (g04-harness.test.ts), no database: `probe-hang` never reaches a boundary and stays alive until the parent kills it; `probe-kill` writes
// 1 MiB to stderr (more than a pipe holds, so the parent is still reading when the child dies), passes boundaries "probe 0", "probe 1", ... and dies at
// <crashAt> exactly as the real scenarios do; it never goes on to the database (a probe that was not killed says "finished" and exits).
if (scenario === "probe-hang") {
  setInterval(() => undefined, 1 << 30);
  await new Promise<never>(() => undefined);
}
if (scenario === "probe-kill") {
  writeAll(2, `${".".repeat(1 << 20)}\n`);
  for (let i = 0; i <= Number(crashAt); i++) chaos.hit(`probe ${i}`);
  writeSync(1, "finished\n");
  process.exit(0);
}
const storage = await openStore(JSON.parse(specJson) as StoreSpec);
if (scenario === "tool" || scenario === "tool-replay") {
  // The protected effect inside a tool the model calls (g04-tool.ts): its own adapter, with the tool and the reading model.
  const run = await childToolRun(storage, directory, chaos, scenario === "tool-replay" ? "safe" : undefined);
  process.stdout.write("finished\n");
  await run.close();
  await storage.close();
  process.exit(0);
}
// The wait scenario does not talk to a model: no adapter there.
const adapter = scenario === "path" ? (await openAdapter(join(directory, "pi"), ANSWER)).adapter : undefined;
const clock = new Clock();
const world = { storage, directory, chaos, clock: clock.now, ...(adapter === undefined ? {} : { conversation: () => piConversation(adapter) }) };
const slice = await startProcess(world, "child");
if (scenario === "wait") await waitScenario(slice, world, clock); else await runPath(slice);
process.stdout.write("finished\n");
await adapter?.close();
await storage.close();
