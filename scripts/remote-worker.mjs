#!/usr/bin/env node
// The remote worker program (card L05e): `node scripts/remote-worker.mjs --config worker.json`.
// It reads the configuration (see `remote-host.mjs`), takes the host credential from NIMBLENEWT_WORKER_TOKEN or the file the configuration names, and runs until it is stopped (SIGINT, SIGTERM): the poller ends and the sandbox launcher stops.
// Every line it prints is plain and holds no credential or provider key.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRemoteConfig, startRemoteWorker } from "./remote-host.mjs";
import { safeMessage } from "./safe-error.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const at = argv.indexOf("--config");
if (at < 0 || argv[at + 1] === undefined) {
  console.error("usage: node scripts/remote-worker.mjs --config worker.json   (the host credential is NIMBLENEWT_WORKER_TOKEN or the tokenFile the configuration names)");
  process.exit(2);
}
let host;
try {
  const config = readRemoteConfig(resolve(argv[at + 1]));
  host = await startRemoteWorker({ root }, { ...config, log: (line) => console.log(line) });
} catch (error) {
  console.error(`the remote worker host did not start: ${safeMessage(error, 400)}`);
  process.exit(1);
}
console.log("the remote worker host is running");
// A stop ends the held poll at once (the connection is closed, so the controller sees the host go) and then the sandbox launcher; a second signal does not start a second stop, and a stop that fails says so and exits non-zero.
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  host.stop().then(() => process.exit(0), (error) => { console.error(`the remote worker host did not stop cleanly: ${safeMessage(error, 400)}`); process.exit(1); });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
await host.finished;
