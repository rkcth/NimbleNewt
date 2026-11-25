import { safeText, workerFileChannelFromEnv } from "@nimblenewt/contracts";
import { runWorker } from "./process.js";

// Entry point of the worker process: the channel is standard input and output (or, in the native Windows container, two files). Nothing else of the environment is read, and anything that is not a channel line goes to standard error.
const log = console.log;
console.log = (...args: unknown[]) => { console.error(...args.map((a) => (typeof a === "string" || a instanceof Error ? safeText(a, 8000) : a))); };
void log;
// Inside the native Windows container a pipe cannot be made, so the supervisor sets two file names and the same lines go through those files (card A03b, slice 4).
const files = workerFileChannelFromEnv(process.env);
if (files === undefined) await runWorker({ input: process.stdin, write: (text) => { process.stdout.write(text); } });
else {
  try { await runWorker({ input: files.input, write: (text) => { files.write(text); } }); } finally { files.close(); }
}
process.exit(0);
