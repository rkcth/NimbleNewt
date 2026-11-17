#!/usr/bin/env node
// The `git` a bench agent finds first on its PATH (W01 follow-up "w01iso"). Usage: git-guard.mjs <config.json> <git args...>
// The config (written by lib/isolation.mjs) names the real git, the run's own folders and a log file. It refuses, with a
// plain message on stderr and exit status 1:
//   - a push (push, send-pack, http-push), unless every destination is a local repository inside the run's own folders
//     (its checkout or its temporary folder; NimbleNewt's own tests push to bare repositories they make there);
//   - send-email;
//   - `remote add` / `remote set-url` to an address that is not a local folder;
//   - a setting that would loosen the run's git settings (ssh command, URL rewrites, allowed protocols, credential
//     helpers, push settings, remote addresses that are not local folders, http and include settings), given with -c,
//     --config-env, GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT, or written with `git config` in any scope;
// and runs the real git otherwise, without GIT_SSH, GIT_SSH_COMMAND, GIT_PROXY_COMMAND or an askpass program.
// Each refusal is logged (its kind only) to the config's log, which the bench reads after the run.
// This is a guard for an agent following its habits, not a sandbox: an agent that runs the real git by its full path
// gets past it. What it then meets is the run's git settings, and on Linux a home folder with no keys in it.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
export const PUSH_REFUSED = "pushing is disabled in this environment";

const VALUE_GLOBALS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"]);

/** Splits git's global options from the subcommand. */
export function parseGlobal(args, env = {}) {
  const dirs = [], configs = [];
  let i = 0;
  while (i < args.length && typeof args[i] === "string" && args[i].startsWith("-")) {
    const a = args[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    let value = inline;
    if (VALUE_GLOBALS.has(name) && inline === undefined) { value = args[i + 1]; i += 2; } else i += 1;
    if (name === "-C" && value !== undefined) dirs.push(value);
    else if (name === "-c" && value !== undefined) configs.push(splitKv(value));
    else if (name.startsWith("-c") && name.length > 2 && !name.startsWith("--")) configs.push(splitKv(name.slice(2)));
    else if (name === "--config-env" && value !== undefined) { const [k, v] = splitKv(value); configs.push([k, env[v] ?? ""]); }
  }
  return { dirs, configs, sub: args[i], rest: args.slice(i + 1) };
}

const splitKv = (s) => { const j = String(s).indexOf("="); return j < 0 ? [String(s), "true"] : [s.slice(0, j), s.slice(j + 1)]; };

/** The settings a git environment carries (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT/KEY_n/VALUE_n). */
export function envConfigs(env) {
  const out = [];
  const params = env.GIT_CONFIG_PARAMETERS;
  if (typeof params === "string") for (const m of params.matchAll(/'([^']*)'(?:='([^']*)')?/g)) out.push(m[2] === undefined ? splitKv(m[1]) : [m[1], m[2]]);
  const n = Number(env.GIT_CONFIG_COUNT);
  if (Number.isInteger(n) && n > 0) for (let k = 0; k < Math.min(n, 1000); k++) out.push([String(env[`GIT_CONFIG_KEY_${k}`] ?? ""), String(env[`GIT_CONFIG_VALUE_${k}`] ?? "")]);
  return out;
}

const realish = (p) => {
  // The real path of the nearest existing ancestor, with the rest appended (a destination may not exist yet).
  let cur = resolve(p);
  const tail = [];
  for (;;) {
    try { return [realpathSync(cur), ...tail].join(sep); } catch { /* go up */ }
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    tail.unshift(cur.slice(up.length).replace(/^[\\/]+/, ""));
    cur = up;
  }
};

/** Whether `url` names a local folder (a path or file:// URL), and if so its real path; otherwise null. */
export function localPath(url, cwd) {
  const u = String(url);
  if (/^file:\/\//i.test(u)) { try { return realish(fileURLToPath(u)); } catch { return null; } }
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(u)) return null; // <transport>::<address>, e.g. ext::
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(u)) return null; // https://, ssh://, git://
  const drive = IS_WIN && /^[A-Za-z]:[\\/]/.test(u);
  if (!drive && /^[^/\\]*:/.test(u)) return null; // scp-like host:path
  return realish(resolve(cwd, u));
}

const inside = (p, roots) => p !== null && roots.some((r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep));

/** Why a setting may not be given or written, or null when it may. */
export function protectedSetting(key, value, { cwd, roots }) {
  const k = String(key).toLowerCase();
  const v = String(value ?? "");
  if (k === "core.sshcommand") return v === "/bin/false" || v === "false" ? null : "the ssh command";
  if (k === "core.gitproxy" || k === "core.askpass") return "a git proxy or askpass program";
  if (/^url\..*\.(?:push)?insteadof$/.test(k)) return "a URL rewrite";
  if (k === "protocol.allow") return v === "never" ? null : "the allowed protocols";
  if (/^protocol\..+\.allow$/.test(k)) return k === "protocol.file.allow" ? null : "the allowed protocols";
  if (/^credential\./.test(k)) return /\.helper$/.test(k) && v === "" ? null : "a credential setting";
  if (/^push\./.test(k)) return k === "push.default" && v === "nothing" ? null : "a push setting";
  if (/^remote\..+\.(?:push)?url$/.test(k)) return localPath(v, cwd) !== null ? null : "a remote address that is not a local folder";
  if (/^remote\..+\.(?:receivepack|uploadpack|proxy|vcs)$/.test(k)) return "a remote's program or proxy";
  if (/^(?:http|ssh|include|includeif)\./.test(k)) return "an http, ssh or include setting";
  return null;
}

/** The section a protected key belongs to, for `--unset`, `--remove-section` and `--rename-section`. */
const PROTECTED_SECTION = /^(?:core\.(?:sshcommand|gitproxy|askpass)|url|protocol|credential|push|remote|http|ssh|include|includeif)(?:\.|$)/i;

const CONFIG_VALUE_OPTS = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment", "--value", "--file="]);
const CONFIG_READ = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--get-color", "--get-colorbool", "--show-origin", "--show-scope", "--name-only"]);
const CONFIG_UNSET = new Set(["--unset", "--unset-all", "--remove-section", "--rename-section"]);

/** A `git config` call: null when allowed, else why not. */
export function checkConfig(rest, ctx) {
  const pos = [];
  let read = false, unset = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const name = a.startsWith("--") && a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (CONFIG_VALUE_OPTS.has(name) && !a.includes("=")) { i++; continue; }
    if (a === "-e" || a === "--edit") return "editing the settings in an editor";
    if (CONFIG_READ.has(name)) { read = true; continue; }
    if (CONFIG_UNSET.has(name)) { unset = true; continue; }
    if (a.startsWith("-")) continue;
    pos.push(a);
  }
  // Newer git: `git config get|list|set|unset|rename-section|remove-section|edit ...`.
  if (["get", "list"].includes(pos[0])) return null;
  if (pos[0] === "edit") return "editing the settings in an editor";
  if (["unset", "remove-section", "rename-section"].includes(pos[0])) { pos.shift(); unset = true; }
  else if (pos[0] === "set") pos.shift();
  if (read) return null;
  if (unset) return pos[0] !== undefined && PROTECTED_SECTION.test(pos[0]) ? "removing a protected setting" : null;
  if (pos.length < 2) return null; // a read of one key
  return protectedSetting(pos[0], pos[1], ctx);
}

/** A push's destinations: null when allowed, else why not. `git(args)` runs the real git (for the remotes' addresses). */
export function checkPush(rest, { cwd, roots, git }) {
  let repo = null;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") { positional.push(...rest.slice(i + 1)); break; }
    if (/^--(?:receive-pack|exec)(?:=|$)/.test(a)) return "a push with its own receive-pack program";
    if (a.startsWith("--repo=")) { repo = a.slice(7); continue; }
    if (a === "--repo") { repo = rest[++i]; continue; }
    if (a === "-o" || a === "--push-option") { i++; continue; }
    if (a.startsWith("-")) continue;
    positional.push(a);
  }
  repo = repo ?? positional[0] ?? null;
  const remotes = (git(["remote"]) ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const urlsOf = (name) => (git(["remote", "get-url", "--push", "--all", name]) ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let urls;
  if (repo !== null && remotes.includes(repo)) urls = urlsOf(repo);
  else if (repo !== null) {
    urls = [repo, (git(["ls-remote", "--get-url", repo]) ?? "").trim()].filter(Boolean);
    // A name that is neither a remote nor an existing folder (an `origin` the guard refused to add): say so plainly.
    const p = localPath(repo, cwd);
    if (p !== null && !existsSync(p)) return "no such remote or repository in this run's folders";
  }
  else urls = remotes.flatMap(urlsOf);
  if (repo !== null && urls.length === 0) return "a push whose destination could not be read";
  for (const u of urls) if (!inside(localPath(u, cwd), roots)) return "a push outside this run's own folders";
  return null;
}

/** A `git remote` call: null when allowed, else why not. */
export function checkRemote(rest, { cwd }) {
  const op = rest[0];
  if (op !== "add" && op !== "set-url") return null;
  const pos = [];
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-t" || a === "-m") { i++; continue; }
    if (a.startsWith("-")) continue;
    pos.push(a);
  }
  const url = pos[1];
  if (url === undefined) return null; // git reports the usage
  return localPath(url, cwd) === null ? "a remote that is not a local folder" : null;
}

/** The whole decision for one git call: { refuse: reason } or { refuse: null }. */
export function decide(args, { cwd, roots, env, git }) {
  const g = parseGlobal(args, env);
  let dir = cwd;
  for (const d of g.dirs) dir = resolve(dir, d);
  const ctx = { cwd: dir, roots, git: (a) => git(a, dir) };
  for (const [k, v] of [...g.configs, ...envConfigs(env)]) {
    const why = protectedSetting(k, v, ctx);
    if (why) return { refuse: `changing ${why} is disabled in this environment`, kind: "setting" };
  }
  switch (g.sub) {
    case "push": case "send-pack": case "http-push": {
      const why = checkPush(g.rest, ctx);
      return why ? { refuse: `${PUSH_REFUSED} (${why})`, kind: "push" } : { refuse: null };
    }
    case "send-email": return { refuse: "sending mail is disabled in this environment", kind: "send-email" };
    case "remote": {
      const why = checkRemote(g.rest, ctx);
      return why ? { refuse: `adding ${why} is disabled in this environment; ${PUSH_REFUSED}`, kind: "remote" } : { refuse: null };
    }
    case "config": {
      const why = checkConfig(g.rest, ctx);
      return why ? { refuse: `changing ${why} is disabled in this environment`, kind: "setting" } : { refuse: null };
    }
    default: return { refuse: null };
  }
}

const STRIP = ["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_PROXY_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "SSH_AUTH_SOCK"];

function main() {
  const [cfgPath, ...args] = process.argv.slice(2);
  let cfg;
  try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { process.stderr.write("git: the bench's git settings could not be read; git is disabled\n"); process.exit(1); }
  const env = { ...process.env };
  for (const k of STRIP) delete env[k];
  const runGit = (a, cwd) => { const r = spawnSync(cfg.realGit, a, { cwd, env, encoding: "utf8" }); return r.status === 0 ? r.stdout : null; };
  let d;
  try { d = decide(args, { cwd: process.cwd(), roots: cfg.allowRoots, env, git: runGit }); } catch { d = { refuse: "this git command could not be checked; it is disabled in this environment", kind: "unchecked" }; }
  if (d.refuse) {
    try { appendFileSync(cfg.log, `${new Date().toISOString()} refused ${d.kind}\n`); } catch { /* the log is best effort */ }
    process.stderr.write(`git: ${d.refuse}\n`);
    process.exit(1);
  }
  const r = spawnSync(cfg.realGit, args, { stdio: "inherit", env });
  if (r.error) { process.stderr.write(`git: ${r.error.message}\n`); process.exit(127); }
  if (r.signal) process.kill(process.pid, r.signal);
  process.exit(r.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
