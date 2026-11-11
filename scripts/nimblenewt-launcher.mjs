#!/usr/bin/env node
// The NimbleNewt release launcher (card K02a): a small supervisor that runs the controller of the release the pointer names, waits for that controller to confirm its own start, runs the startup watchdog,
// stops a start that hangs, falls back to the last known good release and restarts, slowing down a crash loop. It reads the pointer, the release directory and launcher-state.json only; it never opens the
// database, so it works when the database cannot. It is not part of any release (a release cannot name `launcher` as an artifact). Needs `npx tsc --build` first.
//
//   node scripts/nimblenewt-launcher.mjs --root RELEASE_ROOT [--entry controller.js] [--switcher pointer|symlink] [-- extra controller arguments]
//
// Exit codes: 0 stopped (SIGTERM, SIGINT or SIGHUP to the launcher, or the controller exited 0 after its start was confirmed: a stop on purpose), 1 usage or unexpected error, 2 blocked (nothing safe to run;
// see the log and release.status, the owner decides), 3 no release is active, 4 gave up after a crash loop (the owner's notice is written), 5 another launcher, or a controller a killed launcher left running, holds
// this release root. A service manager should not restart the launcher on 0 or 2 (nothing changes until the owner acts) and may restart it on 1, 4 and 5 after its own delay.
// The controller's side: exit 0 = stop on purpose (only after its start was confirmed; before, it is a failed start), exit 75 = restart me, anything else = a crash.
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "./nimblenewt.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lib = async (file) => import(pathToFileURL(join(repo, "packages", "controller", "dist", file)).href);

const HELP = `NimbleNewt release launcher

  --root DIR           The release root (holds releases/, the pointer and launcher-state.json). Or NIMBLENEWT_RELEASE_ROOT.
  --entry FILE         The controller's entry file inside a release (default controller.js). Run with Node.js from the release directory.
  --switcher KIND      pointer (current.json, default) or symlink (the 'current' link).
  --node PATH          The Node.js to run it with (default: the one running this launcher). A relative path is taken from the current directory.
  --workers-min N --workers-max N   The worker protocol range a fall-back must speak (default: this build's).
  --grace-seconds N    SIGTERM to SIGKILL grace when a hung start is stopped (default 10).
  --poll-ms N          How often the startup watchdog looks (default 1000).
  --backoff-initial-ms N, --backoff-max-ms N, --stable-seconds N, --give-up-after N
                       Restart rate limit: waits initial * 2^(n-1) (up to max) after the n-th short run in a row; a run of --stable-seconds (default 60) resets it; after --give-up-after (default 20) it exits 4.
  Arguments after -- are passed to the controller.
`;

const intFlag = (flags, name, fallback, { min = 0, max = 86_400_000, scale = 1 } = {}) => {
  if (flags[name] === undefined) return fallback;
  const v = Number(flags[name]);
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new Error(`--${name} must be a whole number from ${min} to ${max}`);
  return v * scale;
};

export async function main(argv, io = { stderr: process.stderr, env: process.env, signal: undefined }) {
  const cut = argv.indexOf("--");
  const own = cut < 0 ? argv : argv.slice(0, cut);
  const passed = cut < 0 ? [] : argv.slice(cut + 1);
  const args = parseArgs(own);
  const err = (t) => io.stderr.write(t.endsWith("\n") ? t : `${t}\n`);
  if (args.flags.help === true || args._[0] === "help") { err(HELP); return 0; }
  const rootFlag = typeof args.flags.root === "string" ? args.flags.root : io.env.NIMBLENEWT_RELEASE_ROOT;
  if (rootFlag === undefined || rootFlag === "") { err("--root is required.\n" + HELP); return 1; }
  const root = resolve(rootFlag);
  const entry = typeof args.flags.entry === "string" ? args.flags.entry : "controller.js";
  if (isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) { err("--entry must be a path inside the release."); return 1; }
  const kind = typeof args.flags.switcher === "string" ? args.flags.switcher : "pointer";
  if (kind !== "pointer" && kind !== "symlink") { err("--switcher must be pointer or symlink."); return 1; }
  let opts;
  try {
    opts = {
      grace: intFlag(args.flags, "grace-seconds", 10_000, { max: 3600, scale: 1000 }),
      poll: intFlag(args.flags, "poll-ms", 1000, { min: 5, max: 60_000 }),
      initial: intFlag(args.flags, "backoff-initial-ms", 1000),
      max: intFlag(args.flags, "backoff-max-ms", 60_000),
      // At least a second: with 0 every run would count as stable and a crash loop would never slow down.
      stable: intFlag(args.flags, "stable-seconds", 60_000, { min: 1, max: 86_400, scale: 1000 }),
      giveUp: intFlag(args.flags, "give-up-after", 20, { min: 1, max: 1_000_000 }),
    };
  } catch (error) { err(error.message); return 1; }
  const { Launcher } = await lib("release/launcher.js");
  const { PointerSwitcher, SymlinkSwitcher } = await lib("release/activation.js");
  const { Supervisor } = await lib("release/supervisor.js");
  const { WORKER_PROTOCOL } = await lib("remote/protocol.js");
  let workers = { min: WORKER_PROTOCOL.min, max: WORKER_PROTOCOL.max };
  if (args.flags["workers-min"] !== undefined || args.flags["workers-max"] !== undefined) {
    try { workers = { min: intFlag(args.flags, "workers-min", workers.min, { min: 1 }), max: intFlag(args.flags, "workers-max", workers.max, { min: 1 }) }; } catch (error) { err(error.message); return 1; }
  }
  const switcher = kind === "symlink" ? new SymlinkSwitcher(root) : new PointerSwitcher(root);
  const launcher = new Launcher({ root, switcher, workers });
  // The child is started from the release directory, so a relative --node would otherwise be looked up there (a file the release brought): it is taken from where the launcher was started instead.
  const node = typeof args.flags.node === "string" && args.flags.node !== "" ? (/[\\/]/.test(args.flags.node) ? resolve(args.flags.node) : args.flags.node) : process.execPath;
  const abort = new AbortController();
  // A repeated signal (a second Ctrl-C, a service manager's second SIGTERM) must not fall through to Node's default, which would end the launcher in the middle of the stop and leave the controller running alone.
  const onSignal = () => { if (abort.signal.aborted) err(`${new Date().toISOString()} launcher: already stopping`); else abort.abort(); };
  const outer = io.signal;
  const SIGNALS = process.platform === "win32" ? ["SIGTERM", "SIGINT"] : ["SIGTERM", "SIGINT", "SIGHUP"];
  if (outer?.aborted) abort.abort(); else outer?.addEventListener("abort", onSignal, { once: true });
  if (outer === undefined) for (const s of SIGNALS) process.on(s, onSignal);
  const supervisor = new Supervisor({
    launcher,
    root,
    // The child's environment is this process's, unchanged: secrets reach it the way the service manager gave them. This launcher logs none of it.
    child: (release) => ({ command: node, args: [join(release.dir, entry), ...passed], cwd: release.dir, env: io.env }),
    pollMs: opts.poll,
    graceMs: opts.grace,
    backoff: { initialMs: opts.initial, maxMs: opts.max, stableMs: opts.stable, giveUpAfter: opts.giveUp },
    signal: abort.signal,
    log: (line) => err(`${new Date().toISOString()} launcher: ${line}`),
  });
  try {
    const result = await supervisor.run();
    return result.code;
  } finally {
    outer?.removeEventListener("abort", onSignal);
    if (outer === undefined) for (const s of SIGNALS) process.removeListener(s, onSignal);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { process.stderr.write(`launcher: ${String(error?.message ?? error)}\n`); process.exitCode = 1; });
}
