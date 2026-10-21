/**
 * Child process for the real-adapter crash test (card S09). Usage: node real-child.js <directory> <crashAt>. Runs the whole path of the
 * controller slice with the REAL Pi adapter (durable JSONL storage in <directory>/pi) as the conversation, and kills itself with SIGKILL at
 * boundary <crashAt>.
 */
import { join } from "node:path";
import { SqliteStorage } from "@nimblenewt/controller";
import * as sliceHarness from "@nimblenewt/controller/testing";
import { openAdapter, piConversation } from "./conversation.js";

const [directory, crashAt] = process.argv.slice(2) as [string, string];
const { Chaos, Clock, runPath, startProcess, ANSWER } = sliceHarness;
const chaos = new Chaos(Number(crashAt), () => (process.kill(process.pid, "SIGKILL"), Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)));
const storage = await SqliteStorage.open({ path: join(directory, "db.sqlite"), busyTimeoutMs: 20_000 });
const { adapter } = await openAdapter(join(directory, "pi"), ANSWER);
const slice = await startProcess({ storage, directory, chaos, clock: new Clock().now, conversation: () => piConversation(adapter) }, "child");
await runPath(slice);
process.stdout.write("finished\n");
await adapter.close();
await storage.close();
