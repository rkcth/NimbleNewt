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
// The label the process dies at goes to stderr first (synchronously), so the parent can check the kill landed on the boundary it meant.
const chaos: InstanceType<typeof Chaos> = new Chaos(Number(crashAt), () => (writeSync(2, `${KILLED_AT}${JSON.stringify(chaos.labels.at(-1))}\n`), process.kill(process.pid, "SIGKILL"), Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)));
// Harness probes (g04-child.test.ts), no database: `probe-hang` never reaches a boundary and stays alive until the parent kills it; `probe-kill` passes
// boundaries "probe 0", "probe 1", ... and dies at <crashAt> exactly as the real scenarios do.
if (scenario === "probe-hang") {
  setInterval(() => undefined, 1 << 30);
  await new Promise<never>(() => undefined);
}
if (scenario === "probe-kill") for (let i = 0; i <= Number(crashAt); i++) chaos.hit(`probe ${i}`);
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
