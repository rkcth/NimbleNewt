import { safeText } from "@nimblenewt/contracts";
import { runWorker } from "./process.js";

// Entry point of the worker process: the channel is standard input and output. Nothing else of the environment is read, and anything that is not a channel line goes to standard error.
const log = console.log;
console.log = (...args: unknown[]) => { console.error(...args.map((a) => (typeof a === "string" || a instanceof Error ? safeText(a, 8000) : a))); };
void log;
await runWorker({ input: process.stdin, write: (text) => { process.stdout.write(text); } });
process.exit(0);
