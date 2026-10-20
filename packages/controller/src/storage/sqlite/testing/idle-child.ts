/**
 * Opens a worker-thread store, uses it and leaves it open, then does nothing else: the process must be able to end by itself, because
 * an idle store holds no reference that keeps it alive. Usage: node idle-child.js <database>.
 */
import { SqliteWorkerStorage } from "../worker-storage.js";

const storage = await SqliteWorkerStorage.open({ path: process.argv[2]! });
await storage.currentEpoch();
process.stdout.write("opened\n");
