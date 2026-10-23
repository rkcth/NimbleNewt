/**
 * Child process for card G04. Usage: node g04-child.js <store spec JSON> <directory> <crashAt> <scenario>. Runs the whole path of the controller slice
 * (scenario `path`, or `wait`, see g04-wait.ts) over the given real database with the REAL Pi adapter (durable JSONL storage in <directory>/pi) in the same
 * process, and kills itself with SIGKILL at boundary <crashAt>.
 */
import { join } from "node:path";
import { ANSWER, Chaos, Clock, openAdapter, openStore, piConversation, runPath, startProcess, type StoreSpec } from "./g04-fixture.js";
import { waitScenario } from "./g04-wait.js";

const [specJson, directory, crashAt, scenario] = process.argv.slice(2) as [string, string, string, string];
const chaos = new Chaos(Number(crashAt), () => (process.kill(process.pid, "SIGKILL"), Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)));
const storage = await openStore(JSON.parse(specJson) as StoreSpec);
// The wait scenario does not talk to a model: no adapter there.
const adapter = scenario === "path" ? (await openAdapter(join(directory, "pi"), ANSWER)).adapter : undefined;
const clock = new Clock();
const world = { storage, directory, chaos, clock: clock.now, ...(adapter === undefined ? {} : { conversation: () => piConversation(adapter) }) };
const slice = await startProcess(world, "child");
if (scenario === "wait") await waitScenario(slice, world, clock); else await runPath(slice);
process.stdout.write("finished\n");
await adapter?.close();
await storage.close();
