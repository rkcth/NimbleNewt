/**
 * Child process for the real-kill run of the vertical slice (card S09). Usage: node child.js <directory> <crashAt>. It runs the whole path
 * over a SQLite file in <directory> and kills itself with SIGKILL at boundary number <crashAt> (a boundary that is never reached lets the
 * path finish and prints "finished").
 */
import { join } from "node:path";
import { SqliteStorage } from "../storage/sqlite/index.js";
import { Chaos } from "./chaos.js";
import { Clock, runPath, startProcess } from "./pipeline.js";

const [directory, crashAt] = process.argv.slice(2) as [string, string];
const chaos = new Chaos(Number(crashAt), () => process.kill(process.pid, "SIGKILL"));
const storage = await SqliteStorage.open({ path: join(directory, "db.sqlite"), busyTimeoutMs: 20_000 });
const clock = new Clock();
const slice = await startProcess({ storage, directory, chaos, clock: clock.now }, "child");
await runPath(slice);
process.stdout.write("finished\n");
await storage.close();
