#!/usr/bin/env node
// The controller-down watchdog (card U11d): a process OUTSIDE the controller. It needs no database and no controller credential. Needs `npx tsc --build` first.
//   NIMBLENEWT_WATCHDOG_WEBHOOK=https://... node scripts/nimblenewt-watchdog.mjs --record ABS_FILE (--heartbeat-file ABS_FILE | --url http://...) [--webhook-file ABS_FILE] [--every-seconds N] [--failures N] [--remind-minutes N] [--once]
// While the controller does not answer it POSTs {"text": ...} to the webhook (the owner's own chat bridge address). The controller, when it runs again, raises the outage from the record file
// (start it with the same file as its `watchdog` option). The webhook address usually holds the channel's secret, so it is never taken from the command line (other users of the machine can read that): it comes
// from the NIMBLENEWT_WATCHDOG_WEBHOOK environment variable or from the first line of a file only its owner can read (--webhook-file). https only, except to this machine. Prints no address or credential.
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeMessage } from "./safe-error.mjs";

export const WEBHOOK_ENV = "NIMBLENEWT_WATCHDOG_WEBHOOK";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function webhookFrom(flags, env) {
  if (flags.webhook !== undefined) throw new Error(`the webhook address is not taken from the command line (other users of this machine can read it there); set ${WEBHOOK_ENV} or give --webhook-file`);
  if (flags["webhook-file"] !== undefined) {
    const file = flags["webhook-file"];
    if (!isAbsolute(file)) throw new Error("--webhook-file needs an absolute file path");
    const st = await stat(file).catch(() => undefined);
    if (st === undefined || !st.isFile() || st.size > 4096) throw new Error("--webhook-file must be a readable file of at most 4096 bytes");
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new Error("--webhook-file must be readable by its owner only (chmod 600)");
    const first = (await readFile(file, "utf8")).split(/\r?\n/)[0].trim();
    if (first === "") throw new Error("--webhook-file is empty");
    return first;
  }
  const fromEnv = env[WEBHOOK_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  throw new Error(`no webhook address: set ${WEBHOOK_ENV} or give --webhook-file`);
}

export async function main(argv, io = { stderr: process.stderr, stdout: process.stdout }, lib, env = process.env, signals = process) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // The argument itself is not repeated: it may be an address that holds a secret, given in the wrong place.
    if (!a.startsWith("--")) { io.stderr.write("unexpected argument (every option starts with --)\n"); return 2; }
    const k = a.slice(2);
    if (k === "once") { flags.once = true; continue; }
    flags[k] = argv[++i];
    if (flags[k] === undefined) { io.stderr.write(`--${k.slice(0, 40)} needs a value\n`); return 2; }
  }
  const known = new Set(["record", "heartbeat-file", "url", "webhook", "webhook-file", "every-seconds", "failures", "remind-minutes", "once"]);
  for (const k of Object.keys(flags)) if (!known.has(k)) { io.stderr.write(`unknown option --${k.slice(0, 40)}\n`); return 2; }
  const num = (k, lo, hi) => { if (flags[k] === undefined) return undefined; const n = Number(flags[k]); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`--${k} must be a whole number from ${lo} to ${hi}`); return n; };
  try {
    if (flags.record === undefined || !isAbsolute(flags.record)) throw new Error("--record needs an absolute file path");
    if ((flags["heartbeat-file"] === undefined) === (flags.url === undefined)) throw new Error("give exactly one of --heartbeat-file and --url");
    if (flags["heartbeat-file"] !== undefined && !isAbsolute(flags["heartbeat-file"])) throw new Error("--heartbeat-file needs an absolute file path");
    const webhook = await webhookFrom(flags, env);
    const every = (num("every-seconds", 1, 3600) ?? 15) * 1000;
    const w = lib ?? await import(pathToFileURL(join(repo, "packages", "controller", "dist", "notifications", "watchdog.js")).href);
    // The heartbeat is stale after two minutes, or after three looks when they are further apart: the probe reads a gap of more than half its limit as this process having been paused, so the limit must
    // be well above the time between two looks or no look would ever judge.
    const probe = flags.url !== undefined ? w.httpProbe(flags.url) : w.heartbeatProbe(flags["heartbeat-file"], { staleMs: Math.max(120_000, 3 * every) });
    const remind = num("remind-minutes", 1, 1440);
    const dog = new w.DownWatchdog({ file: flags.record, probe, tell: w.webhookTell(webhook), failuresBeforeDown: num("failures", 1, 100), ...(remind === undefined ? {} : { remindEveryMs: remind * 60_000 }), onError: (e) => io.stderr.write(`watchdog: ${safeMessage(e, 200)}\n`) });
    if (flags.once) { const r = await dog.tick(); io.stdout.write(`${r.state}${r.told ? " (told)" : ""}\n`); return 0; }
    // A stop request ends the pause between looks at once (it is not held for up to an hour by the interval).
    let stop = false; let wake = () => undefined;
    const onSignal = () => { stop = true; wake(); };
    for (const s of ["SIGINT", "SIGTERM"]) signals.once(s, onSignal);
    while (!stop) {
      await dog.tick();
      if (stop) break;
      await new Promise((r) => { const timer = setTimeout(r, every); wake = () => { clearTimeout(timer); r(); }; });
    }
    return 0;
  } catch (e) { io.stderr.write(`the watchdog did not start: ${safeMessage(e, 300)}\n`); return 1; }
}
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exit(await main(process.argv.slice(2)));
