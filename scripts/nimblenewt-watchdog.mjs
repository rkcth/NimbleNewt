#!/usr/bin/env node
// The controller-down watchdog (card U11d): a process OUTSIDE the controller. It needs no database and no controller credential. Needs `npx tsc --build` first.
//   node scripts/nimblenewt-watchdog.mjs --record ABS_FILE (--heartbeat-file ABS_FILE | --url http://...) --webhook URL [--every-seconds N] [--failures N] [--remind-minutes N] [--once]
// While the controller does not answer it POSTs {"text": ...} to the webhook (the owner's own chat bridge address). The controller, when it runs again, raises the outage from the record file
// (start it with the same file as its `watchdog` option). Prints no address or credential.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeMessage } from "./safe-error.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function main(argv, io = { stderr: process.stderr, stdout: process.stdout }, lib) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { io.stderr.write(`unexpected argument ${a}\n`); return 2; }
    const k = a.slice(2);
    if (k === "once") { flags.once = true; continue; }
    flags[k] = argv[++i];
    if (flags[k] === undefined) { io.stderr.write(`--${k} needs a value\n`); return 2; }
  }
  const known = new Set(["record", "heartbeat-file", "url", "webhook", "every-seconds", "failures", "remind-minutes", "once"]);
  for (const k of Object.keys(flags)) if (!known.has(k)) { io.stderr.write(`unknown option --${k}\n`); return 2; }
  const num = (k, lo, hi) => { if (flags[k] === undefined) return undefined; const n = Number(flags[k]); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`--${k} must be a whole number from ${lo} to ${hi}`); return n; };
  try {
    if (flags.record === undefined || !resolve(flags.record).startsWith("/") && !/^[A-Za-z]:/.test(flags.record)) throw new Error("--record needs an absolute file path");
    if ((flags["heartbeat-file"] === undefined) === (flags.url === undefined)) throw new Error("give exactly one of --heartbeat-file and --url");
    if (flags.webhook === undefined || !/^https?:\/\//.test(flags.webhook)) throw new Error("--webhook needs an http or https address");
    const every = (num("every-seconds", 1, 3600) ?? 15) * 1000;
    const w = lib ?? await import(pathToFileURL(join(repo, "packages", "controller", "dist", "notifications", "watchdog.js")).href);
    const probe = flags.url !== undefined ? w.httpProbe(flags.url) : w.heartbeatProbe(flags["heartbeat-file"]);
    const remind = num("remind-minutes", 1, 1440);
    const dog = new w.DownWatchdog({ file: flags.record, probe, tell: w.webhookTell(flags.webhook), failuresBeforeDown: num("failures", 1, 100), ...(remind === undefined ? {} : { remindEveryMs: remind * 60_000 }), onError: (e) => io.stderr.write(`watchdog: ${safeMessage(e, 200)}\n`) });
    if (flags.once) { const r = await dog.tick(); io.stdout.write(`${r.state}${r.told ? " (told)" : ""}\n`); return 0; }
    let stop = false; for (const s of ["SIGINT", "SIGTERM"]) process.once(s, () => { stop = true; });
    while (!stop) { await dog.tick(); await new Promise((r) => setTimeout(r, every)); }
    return 0;
  } catch (e) { io.stderr.write(`the watchdog did not start: ${safeMessage(e, 300)}\n`); return 1; }
}
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exit(await main(process.argv.slice(2)));
