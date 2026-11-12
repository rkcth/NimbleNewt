#!/usr/bin/env node
// The NimbleNewt controller entry (card K02a follow-up, "production wiring"): the program the release launcher (scripts/nimblenewt-launcher.mjs) runs from `releases/<id>/controller.js`, and that an
// operator can run by hand. It reads the configuration, starts the controller exactly as `nimblenewt.mjs start` does (same `launch`), but with no terminal chat: it runs until it is told to stop.
//
//   node scripts/nimblenewt-controller.mjs [--data DIR | --config FILE] [--serve] [--allow-unsupported-environment] [--local-host-environments]
//                                          [--release-root DIR] [--release-switcher pointer|symlink]
//
// Needs `npx tsc --build` first and an existing configuration (`node scripts/nimblenewt.mjs init`); it never writes a starter one. Settings, in the order they are looked up:
//   data directory         --data, NIMBLENEWT_DATA, ~/.nimblenewt           (the configuration is DIR/nimblenewt.config.json unless --config is given)
//   release root           --release-root, NIMBLENEWT_RELEASE_ROOT          (the launcher sets it); off when neither is given
//   release pointer kind   --release-switcher, NIMBLENEWT_RELEASE_SWITCHER  (the launcher sets it, so both sides agree)
//   running release        NIMBLENEWT_RUNNING_RELEASE only (the launcher sets it) -> StartOptions.releases.runningRelease; it needs the release root
//   liveness heartbeat     NIMBLENEWT_HEARTBEAT_FILE / _TOKEN / _INTERVAL_MS (the launcher sets them; startController reads them from the environment given here)
//   environment changes    --local-host-environments or NIMBLENEWT_LOCAL_HOST_ENVIRONMENTS=1; OFF by default (card A09b)
// Secrets: provider keys and the database address are looked up by their configured NAME in the operating system's secret store (the owner's credential only there), and for a name the store does not
// hold in the environment as NIMBLENEWT_SECRET_<NAME> (a service manager's way). Nothing secret is printed or put in an argument.
//
// Exit codes (the contract of release/supervisor.ts, CONTROLLER_EXIT): 0 stopped on purpose (SIGTERM, SIGINT or SIGHUP, after the controller was closed), 75 restart me (a database move or rollback the owner
// asked for, when started by the launcher), 1 could not start or could not close cleanly. The launcher counts a 0 as a stop on purpose only after this process confirmed its start; the confirmation is made by startController
// itself (when the record names the running release as current) and this entry says in the log whether it happened.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { environmentsRequested, localHostBuilder } from "./local-host.mjs";
import { safeMessage } from "./safe-error.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = async (pkg) => import(pathToFileURL(join(root, "packages", pkg, "dist", "index.js")).href);
const lib = async (file) => import(pathToFileURL(join(root, "packages", "controller", "dist", file)).href);

const HELP = `NimbleNewt controller entry

  --data DIR                     The data directory (or NIMBLENEWT_DATA; default ~/.nimblenewt). The configuration is DIR/nimblenewt.config.json.
  --config FILE                  The configuration file, when it is somewhere else.
  --serve                        Also listen for the conversation on this computer (loopback only).
  --allow-unsupported-environment   Start on a system the start-up check does not support (recorded and printed at every start).
  --local-host-environments      Let the worker host install approved package changes into agents' environments (or NIMBLENEWT_LOCAL_HOST_ENVIRONMENTS=1). Off by default.
  --release-root DIR             The release root (or NIMBLENEWT_RELEASE_ROOT, which the launcher sets): turns on release staging and activation.
  --release-switcher KIND        pointer or symlink (or NIMBLENEWT_RELEASE_SWITCHER). Default: the controller's own (symlink; pointer on Windows). The launcher sets it.
  NIMBLENEWT_RUNNING_RELEASE     Set by the launcher: the release this process runs as. Needs the release root.
Exit codes: 0 stopped on purpose, 75 restart me, 1 could not start. Stops on SIGTERM, SIGINT or SIGHUP.
`;

const BOOLEAN = new Set(["serve", "allow-unsupported-environment", "local-host-environments", "help"]);
const VALUE = new Set(["data", "config", "release-root", "release-switcher"]);

/** Strict arguments: an unknown flag, a flag without its value or a flag given twice is an error (a supervised program must not run with a setting it silently ignored). */
export function parseControllerArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument "${a}"`);
    const eq = a.indexOf("=");
    const k = a.slice(2, eq < 0 ? undefined : eq);
    if (Object.hasOwn(flags, k)) throw new Error(`--${k} is given more than once`);
    if (BOOLEAN.has(k)) { if (eq >= 0) throw new Error(`--${k} takes no value`); flags[k] = true; continue; }
    if (!VALUE.has(k)) throw new Error(`unknown option --${k}`);
    const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
    if (v === undefined || v === "" || (eq < 0 && v.startsWith("--"))) throw new Error(`--${k} needs a value`);
    flags[k] = v;
  }
  return flags;
}

/**
 * What the entry's settings say, checked, with no side effect: { dataDir, configFile, release?: { root, switcher?, runningRelease? }, environments, serve, allowUnsupported }.
 * Throws a plain-words error for a setting that cannot be right (a running release without a release root, a malformed release ID, an unknown pointer kind).
 */
export function controllerSettings(flags, env) {
  const dataDir = resolve(flags.data ?? (env.NIMBLENEWT_DATA || join(homedir(), ".nimblenewt")));
  const configFile = flags.config === undefined ? join(dataDir, "nimblenewt.config.json") : resolve(flags.config);
  const rootGiven = flags["release-root"] ?? (env.NIMBLENEWT_RELEASE_ROOT || undefined);
  const kind = flags["release-switcher"] ?? (env.NIMBLENEWT_RELEASE_SWITCHER || undefined);
  const running = env.NIMBLENEWT_RUNNING_RELEASE || undefined;
  if (kind !== undefined && kind !== "pointer" && kind !== "symlink") throw new Error("the release switcher must be pointer or symlink");
  if (running !== undefined && !/^rcn-[0-9a-f]{24}$/.test(running)) throw new Error("NIMBLENEWT_RUNNING_RELEASE is not a release ID");
  if (running !== undefined && rootGiven === undefined) throw new Error("NIMBLENEWT_RUNNING_RELEASE is set but there is no release root (--release-root or NIMBLENEWT_RELEASE_ROOT): the release this process runs as could not be confirmed");
  if (kind !== undefined && rootGiven === undefined) throw new Error("a release switcher is given but there is no release root");
  if (running !== undefined) {
    // Under the launcher the process runs in the release directory, so a relative path would name a folder inside the release (a new, empty installation for every release); and the launcher's own root and
    // pointer kind must be the ones used, or this start could never be confirmed. Both are refused rather than guessed.
    for (const [what, v] of [["--data", flags.data], ["NIMBLENEWT_DATA", flags.data === undefined ? env.NIMBLENEWT_DATA || undefined : undefined], ["--config", flags.config], ["the release root", rootGiven]]) {
      if (v !== undefined && !isAbsolute(v)) throw new Error(`${what} is the relative path ${JSON.stringify(v)}; under the launcher this process runs in the release directory, so give an absolute path`);
    }
    for (const [flag, name] of [["release-root", "NIMBLENEWT_RELEASE_ROOT"], ["release-switcher", "NIMBLENEWT_RELEASE_SWITCHER"]]) {
      if (flags[flag] !== undefined && env[name] && (flag === "release-root" ? resolve(flags[flag]) !== resolve(env[name]) : flags[flag] !== env[name])) throw new Error(`--${flag} differs from the launcher's ${name}; the launcher's setting must be used`);
    }
  }
  return {
    dataDir, configFile,
    ...(rootGiven === undefined ? {} : { release: { root: resolve(rootGiven), ...(kind === undefined ? {} : { switcher: kind }), ...(running === undefined ? {} : { runningRelease: running }) } }),
    environments: environmentsRequested(flags["local-host-environments"], env.NIMBLENEWT_LOCAL_HOST_ENVIRONMENTS),
    serve: flags.serve === true,
    allowUnsupported: flags["allow-unsupported-environment"] === true,
  };
}

/**
 * The secrets this entry hands to `launch`: the operating system's store first; a name it does not hold may come from NIMBLENEWT_SECRET_<NAME> in the environment. The owner's credential is never read from
 * the environment (an environment variable is visible to every process of the account and would let a caller pose as the owner), and `set` writes only to the store.
 */
export function composeSecrets(store, env, ownerPrefix, environmentSecrets) {
  const fromEnv = environmentSecrets(env);
  // Letter case does not matter: the environment's names are upper case, and the stores treat names that differ only by case as the same.
  const owners = (name) => name.toLowerCase().startsWith(ownerPrefix.toLowerCase());
  return {
    resolve: async (name) => (await store.resolve(name)) ?? (owners(name) ? undefined : fromEnv.resolve(name)),
    set: (name, value) => store.set(name, value),
    ...(store.remove === undefined ? {} : { remove: (name) => store.remove(name) }),
  };
}

/** The start options this entry adds to the launcher's own: release wiring, and the restart request when a supervisor is there to restart the process (and a database move is configured). */
export function controllerStartOptions(settings, config, requestRestart) {
  const restartable = settings.release?.runningRelease !== undefined && (config.controller.databaseTransfer?.targets?.length ?? 0) > 0;
  return {
    ...(settings.release === undefined ? {} : { releases: settings.release }),
    // Only under the launcher: without a supervisor nothing would start the process again, and the owner is told to restart by hand (the controller's own default).
    ...(restartable ? { transfer: { restart: { run: () => requestRestart("the database move or rollback") } } } : {}),
  };
}

/**
 * Whether the launcher's record says this start (the open start attempt) was confirmed: the same test the supervisor makes before it takes an exit 0 as a stop on purpose. The last known good alone is not
 * enough: after a restart or a crash it can still name this release from an earlier run while this start was not confirmed.
 */
export function startConfirmed(state, releaseId) {
  return state?.attempt?.id === releaseId && state.attempt.confirmedAt !== undefined && !(state.failed ?? []).some((f) => f.id === releaseId);
}

/** How long closing the controller may take before the entry gives up and exits 1 (the launcher's own grace usually ends it first). */
export const CLOSE_TIMEOUT_MS = 60_000;

/**
 * @param {string[]} argv
 * @param {{ stderr: { write(t: string): unknown }, env: Record<string, string | undefined>, signal?: AbortSignal, closeTimeoutMs?: number, ready?: (handle: { controller: unknown, requestRestart: (why: string) => void }) => void }} io
 *   `signal` stands for the stop signals in tests; `ready` is called once the controller is up (tests and embedding); `closeTimeoutMs` bounds the close (default CLOSE_TIMEOUT_MS).
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, io = { stderr: process.stderr, env: process.env, signal: undefined }) {
  const err = (t) => io.stderr.write(`${new Date().toISOString()} controller: ${t}\n`);
  let flags;
  let settings;
  try {
    flags = parseControllerArgs(argv);
    if (flags.help === true) { io.stderr.write(HELP); return 0; }
    settings = controllerSettings(flags, io.env);
  } catch (error) { err(`${safeMessage(error, 2000)}\n${HELP}`.trimEnd()); return 1; }
  if (!existsSync(settings.configFile)) { err(`there is no configuration at ${settings.configFile}; create one with: node scripts/nimblenewt.mjs init --data ${settings.dataDir}`); return 1; }

  const stop = new AbortController();
  let restartWanted = false;
  const requestRestart = (why) => { if (!stop.signal.aborted) { restartWanted = true; err(`a restart was requested (${why})`); stop.abort(); } };
  const onSignal = (name) => () => { if (stop.signal.aborted) err("already stopping"); else { err(`${name} received, stopping`); stop.abort(); } };
  const signals = process.platform === "win32" ? ["SIGTERM", "SIGINT"] : ["SIGTERM", "SIGINT", "SIGHUP"];
  const handlers = signals.map((s) => [s, onSignal(s)]);
  const outer = io.signal;
  if (outer?.aborted) stop.abort(); else outer?.addEventListener("abort", () => stop.abort(), { once: true });
  if (outer === undefined) for (const [s, h] of handlers) process.on(s, h);

  let launched;
  try {
    const { loadConfig, formatErrors, chooseSecretStore, environmentSecrets } = await load("config");
    const loaded = loadConfig(readFileSync(settings.configFile, "utf8"));
    if (!loaded.ok) throw new Error(`the configuration ${settings.configFile} is not valid:\n${formatErrors(loaded.errors)}`);
    const config = loaded.config;
    if (settings.release?.runningRelease !== undefined && !isAbsolute(config.installation.dataDir)) throw new Error(`the configuration's installation.dataDir is the relative path ${JSON.stringify(config.installation.dataDir)}; under the launcher this process runs in the release directory, so the configuration must give an absolute path`);
    const { store, reason } = await chooseSecretStore({ dataDir: config.installation.dataDir });
    const { launch, OWNER_SECRET } = await load("controller");
    const secrets = composeSecrets(store, io.env, OWNER_SECRET, environmentSecrets);
    launched = await launch({
      config, secrets, env: io.env, print: (l) => err(l),
      argv: settings.allowUnsupported ? ["--allow-unsupported-environment"] : [],
      localHost: localHostBuilder({ root, load, environments: settings.environments }),
      start: controllerStartOptions(settings, config, requestRestart),
      ...(settings.serve ? { serve: {} } : {}),
    });
    err(`started (secrets are kept in: ${reason})`);
    for (const n of launched.notes) err(n);
    if (settings.release?.runningRelease !== undefined) {
      // startController confirms the start itself; this reads the launcher's own record so the log says whether it happened.
      const { Launcher } = await lib("release/launcher.js");
      const { PointerSwitcher, SymlinkSwitcher } = await lib("release/activation.js");
      const kind = settings.release.switcher ?? (process.platform === "win32" ? "pointer" : "symlink");
      const state = await new Launcher({ root: settings.release.root, switcher: kind === "pointer" ? new PointerSwitcher(settings.release.root) : new SymlinkSwitcher(settings.release.root) }).read();
      if (startConfirmed(state, settings.release.runningRelease)) err(`start confirmed: ${settings.release.runningRelease} is the last known good release`);
      else err(`start NOT confirmed for ${settings.release.runningRelease} (see the release activation lines above, if any): unless the owner confirms the release, the launcher will count this start as failed`);
    }
    io.ready?.({ controller: launched.controller, requestRestart });
    // Nothing in a controller without a dispatcher or a listener keeps the process alive by itself: this timer does, until the stop.
    if (!stop.signal.aborted) {
      const keepAlive = setInterval(() => undefined, 1 << 30);
      try { await new Promise((done) => stop.signal.addEventListener("abort", done, { once: true })); } finally { clearInterval(keepAlive); }
    }
    return await closeAndCode(launched, restartWanted, err, io.closeTimeoutMs ?? CLOSE_TIMEOUT_MS);
  } catch (error) {
    // The start-up check has already printed why (through `print`); it is not said twice.
    if (error?.name !== "UnsupportedEnvironmentError") err(`could not start: ${safeMessage(error, 2000)}`);
    if (launched !== undefined) await launched.close().catch(() => undefined);
    return 1;
  } finally {
    if (outer === undefined) for (const [s, h] of handlers) process.removeListener(s, h);
  }
}

async function closeAndCode(launched, restartWanted, err, timeoutMs) {
  let timer;
  const timedOut = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`it did not finish within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs); });
  try { await Promise.race([launched.close(), timedOut]); } catch (error) { err(`closing failed: ${safeMessage(error, 200)}`); return 1; } finally { clearTimeout(timer); }
  err(restartWanted ? "closed; exiting 75 so the launcher starts it again" : "closed; stopped on purpose");
  return restartWanted ? 75 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The exit code is the contract, so it must not depend on every handle being let go: once main has returned, anything still holding the event loop (a close that timed out, a leaked socket) gets a few
  // seconds and then the process exits with that code anyway (the timer is unref'd, so a clean exit is not delayed).
  const exit = (code) => { process.exitCode = code; setTimeout(() => process.exit(code), 5_000).unref(); };
  main(process.argv.slice(2)).then(exit, (error) => { process.stderr.write(`controller: ${safeMessage(error, 2000)}\n`); exit(1); });
}
