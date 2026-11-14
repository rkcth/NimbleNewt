import { readFile } from "node:fs/promises";
import { redactText } from "../security/redact.js";
import { RemoteWorkerClient } from "./client.js";
import { commandReleaseSuite } from "./release-command-suite.js";
import { readReleaseHostConfig, runReleaseHost } from "./release-host.js";

// The program on a release-test machine (card X09b finish): `node dist/remote/release-host-main.js <config.json>`. The host's credential is read from the file or environment variable the configuration names and
// is taken out of the environment before any test program is started, so no suite ever sees it.
const file = process.argv[2];
const say = (line: string): void => { process.stderr.write(`${new Date().toISOString()} ${redactText(line)}\n`); };
try {
  if (file === undefined) throw new Error("usage: release-host-main <config.json>");
  const config = await readReleaseHostConfig(await readFile(file, "utf8"), file);
  delete process.env["NIMBLENEWT_HOST_TOKEN"];
  if (config.tokenEnv !== undefined) delete process.env[config.tokenEnv];
  const client = new RemoteWorkerClient({ url: config.controllerUrl, token: config.token, workerVersion: "release-host", ...(config.ca === undefined ? {} : { ca: config.ca }) });
  const stop = new AbortController();
  for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, () => stop.abort());
  say(`release host started (${process.platform}/${process.arch})`);
  await runReleaseHost({ client, suite: commandReleaseSuite(config.suite), signal: stop.signal, ...(config.concurrency === undefined ? {} : { concurrency: config.concurrency }), ...(config.intervalSeconds === undefined ? {} : { everyMs: config.intervalSeconds * 1000 }), onTrouble: (id, what, error) => say(`${id === undefined ? "" : `${id}: `}${what}${error instanceof Error ? ` (${error.message})` : ""}`) });
  say("release host stopped");
} catch (error) {
  say(error instanceof Error ? error.message : "the release host stopped");
  process.exitCode = 2;
}
