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
// an alias is judged as what it stands for, and the remotes' addresses are read with the call's own -C, --git-dir and -c;
// and runs the real git otherwise, without GIT_SSH, GIT_SSH_COMMAND, GIT_PROXY_COMMAND or an askpass program, and with the
// run's own git settings (GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM set back, GIT_CONFIG_NOSYSTEM dropped).
// Each refusal is logged (its kind only, tagged when it is the project's own tests at work: see inProjectTests) to the
// config's log, which the bench reads after the run.
// This is a guard for an agent following its habits, not a sandbox: an agent that runs the real git by its full path
// gets past it. What it then meets is the run's git settings, and on Linux a home folder with no keys in it.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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
    else if (name === "--config-env" && value !== undefined) { const [k, v] = splitEnvSpec(value); configs.push([k, env[v] ?? ""]); }
  }
  return { dirs, configs, globals: args.slice(0, i), sub: args[i], rest: args.slice(i + 1) };
}

const splitKv = (s) => { const j = String(s).indexOf("="); return j < 0 ? [String(s), "true"] : [s.slice(0, j), s.slice(j + 1)]; };
// `--config-env=<key>=<envvar>`: git splits at the LAST `=` (git_config_push_env uses strrchr), so a key may hold `=` in its
// subsection (`remote.a=b.url`). Splitting at the first `=` read `remote.a` and let a network remote through (W01d second review).
const splitEnvSpec = (s) => { const j = String(s).lastIndexOf("="); return j < 0 ? [String(s), ""] : [s.slice(0, j), s.slice(j + 1)]; };

/** The settings a git environment carries (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT/KEY_n/VALUE_n). */
export function envConfigs(env) {
  const out = [];
  const params = env.GIT_CONFIG_PARAMETERS;
  if (typeof params === "string") out.push(...parseConfigParameters(params));
  const n = Number(env.GIT_CONFIG_COUNT);
  if (Number.isInteger(n) && n > 0) for (let k = 0; k < Math.min(n, 1000); k++) out.push([String(env[`GIT_CONFIG_KEY_${k}`] ?? ""), String(env[`GIT_CONFIG_VALUE_${k}`] ?? "")]);
  return out;
}

/**
 * GIT_CONFIG_PARAMETERS read the way git reads it (config.c with quote.c's sq_dequote_step): space-separated entries,
 * each `'key=value'` or `'key'='value'` (or `'key'=`, a key without a value), where a quoted word continues across `'\''`
 * and `'\!'`. A simpler pattern stopped at the first `'\''` and missed the settings after it, which git still applied
 * (W01d review). Where git finds the text malformed it refuses to run at all; the entries read up to there are returned.
 */
function parseConfigParameters(text) {
  const out = [];
  let i = 0;
  const word = () => { // a quoted word at i, or null
    if (text[i] !== "'") return null;
    let s = "";
    for (i++; ;) {
      if (i >= text.length) return null;
      const c = text[i++];
      if (c !== "'") { s += c; continue; }
      if (text[i] === "\\" && (text[i + 1] === "'" || text[i + 1] === "!") && text[i + 2] === "'") { s += text[i + 1]; i += 3; continue; }
      return s;
    }
  };
  const space = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f";
  while (i < text.length && space(text[i])) i++;
  while (i < text.length) {
    const key = word();
    if (key === null) break;
    if (text[i] === "=") {
      i++;
      if (text[i] === "'") { const v = word(); if (v === null) break; out.push([key, v]); }
      else if (i >= text.length || space(text[i])) out.push([key, "true"]);
      else break;
    } else if (i >= text.length || space(text[i])) out.push(splitKv(key));
    else break;
    while (i < text.length && space(text[i])) i++;
  }
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
  // core.askPass=echo exactly (W01d review): NimbleNewt's worker gives it on every git call so git never prompts; `echo`
  // answers a prompt with the prompt's own text, never a stored login. Any other askpass program is still refused.
  if (k === "core.askpass") return v === "echo" ? null : "a git proxy or askpass program";
  if (k === "core.gitproxy") return "a git proxy or askpass program";
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

/**
 * git's own commands, which an alias cannot replace (git runs a built-in before looking for an alias of that name): no
 * alias lookup for them. Any other name is looked up, so an unknown one costs one more git call.
 */
const NOT_ALIASES = new Set(("push send-pack http-push send-email remote config fetch clone pull ls-remote submodule status diff log add commit show " +
  "checkout switch branch rev-parse rev-list stash reset restore merge rebase init tag ls-files ls-tree grep blame cherry-pick revert apply rm mv " +
  "worktree for-each-ref cat-file hash-object update-index update-ref diff-index diff-tree diff-files symbolic-ref describe clean reflog shortlog " +
  "format-patch am notes gc fsck version help var merge-base name-rev check-ignore check-attr read-tree write-tree commit-tree show-ref bisect").split(" "));

/** An alias's words (git splits a non-shell alias like a shell would, quotes included). */
export function splitAlias(text) {
  const words = [];
  let cur = null, quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; else if (c === "\\" && quote === '"' && i + 1 < text.length) cur += text[++i]; else cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; cur ??= ""; continue; }
    if (c === "\\" && i + 1 < text.length) { cur = (cur ?? "") + text[++i]; continue; }
    if (/\s/.test(c)) { if (cur !== null) words.push(cur); cur = null; continue; }
    cur = (cur ?? "") + c;
  }
  if (cur !== null) words.push(cur);
  return words;
}

/**
 * The whole decision for one git call: { refuse: reason } or { refuse: null }. The real git is asked (with the call's own
 * global options, so -C, --git-dir and -c count) for the remotes' addresses and for an alias the call may use; an alias
 * is decided as what it stands for. A shell alias (`!...`) runs a shell, whose `git` is this wrapper again.
 */
export function decide(args, { cwd, roots, env, git }, depth = 0) {
  const g = parseGlobal(args, env);
  let dir = cwd;
  for (const d of g.dirs) dir = resolve(dir, d);
  // The real git gets the call's global options minus -C (its folder is already `dir`).
  const globalsNoC = [];
  for (let i = 0; i < g.globals.length; i++) { if (g.globals[i] === "-C") { i++; continue; } globalsNoC.push(g.globals[i]); }
  const ctx = { cwd: dir, roots, git: (a) => git([...globalsNoC, ...a], dir) };
  for (const [k, v] of [...g.configs, ...envConfigs(env)]) {
    const why = protectedSetting(k, v, ctx);
    if (why) return { refuse: `changing ${why} is disabled in this environment`, kind: "setting" };
  }
  if (typeof g.sub === "string" && !NOT_ALIASES.has(g.sub) && /^[A-Za-z0-9][\w.-]*$/.test(g.sub)) {
    const alias = (ctx.git(["config", "--get", `alias.${g.sub}`]) ?? "").replace(/\r?\n$/, "");
    if (alias !== "" && !alias.startsWith("!")) {
      if (depth >= 10) return { refuse: "an alias that leads to itself is disabled in this environment", kind: "unchecked" };
      return decide([...g.globals, ...splitAlias(alias), ...g.rest], { cwd, roots, env, git }, depth + 1);
    }
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

// ---- refusals inside a project's own test run (card W01d) ----
// NimbleNewt's worker gives `-c core.askPass=echo` on every git call it makes (a program that answers nothing, so git never
// prompts), and its tests run that code against repositories they create in the temporary folder. Since the W01d review
// that exact value is let through (protectedSetting); its local clones and fetches add `-c protocol.allow=user`, which is
// still refused. Such calls are not the agent loosening its own git: they are logged with the tag below and the
// bench does not count them as contamination (it reports them apart). A refusal is tagged only when all of these hold:
//   - it is a refused setting, and every refused setting is an askpass or proxy program (core.askpass, core.gitproxy) or the
//     allowed protocols (protocol.allow; W01d review) given
//     for this one call (-c, --config-env, GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT), never written with `git config`;
//   - the same call without those settings is let through by `decide` unchanged: no push outside the run's folders, no
//     remote that is not a local folder, no other refused setting (ssh command, credential helper, URL rewrite, ...);
//   - the call names its subcommand directly (an alias is never tagged) and no argument is a network address; every
//     remote the repository has (its configuration and the call's -c), every branch's remote, and each positional argument
//     of a subcommand that contacts a remote, is a local folder in the run's temporary folder and outside its checkout (so
//     never the checkout or another checkout); no URL rewrite is configured; never `submodule`, a recursing option, an
//     enabled recursion setting, a submodule entry or checked-out modules (W01d second review);
//   - its folder (after -C), any --git-dir / --work-tree / GIT_DIR / GIT_WORK_TREE, and the repository's own git folder
//     (as the real git reports it) all lie in the run's temporary folder (TMPDIR), never the run's checkout.
// The limit: the agent can make the same kind of call itself in a scratch repository in its temporary folder, and that
// refusal is not counted. What it hides is only an askpass or proxy program or protocol.allow refused on a scratch
// repository whose every address is a local folder, for a call
// that would otherwise only touch the run's own folders; anything carrying a push out, a remote, a key path or another
// checkout is still counted, and the call is refused either way.
export const IN_PROJECT_TESTS = "in-project-tests";
// protocol.allow (W01d review): the worker gives `-c protocol.allow=user` with `-c protocol.file.allow=always` when it clones
// or fetches from a local folder; once core.askPass=echo was let through, those calls were refused for protocol.allow
// alone and counted. It is still refused; it is tagged under the same conditions, where every address is a local folder.
const ASKPASS_OR_PROXY = new Set(["core.askpass", "core.gitproxy", "protocol.allow"]);
/** Where the bench's git settings send GitHub addresses instead: loopback port 9 over http, which they do not allow anyway. */
export const REFUSED_ADDRESS = "http://127.0.0.1:9/pushing-is-disabled/";
const REMOTE_SUBS = new Set(["clone", "fetch", "pull", "ls-remote", "push", "send-pack", "http-push", "archive", "remote"]);
// Options of fetch/pull known to take no separate value: a --no-recurse-submodules right after one of them is its own option.
const NO_VALUE_OPTIONS = new Set(["--no-tags", "--tags", "-q", "--quiet", "-v", "--verbose", "--prune", "--force", "-f", "--dry-run", "--atomic", "--all", "--no-write-fetch-head", "--ff-only", "--no-rebase", "--rebase", "--no-edit", "--no-recurse-submodules"]);
// Whether `--no-recurse-submodules` is given as an option: before any `--`, and not the value of the option before it
// (`fetch -o --no-recurse-submodules ...` passes it to the server and still recurses; W01d final re-check).
function noRecurseOption(rest) {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--") return false;
    if (rest[i] !== "--no-recurse-submodules") continue;
    const p = rest[i - 1];
    if (i === 0 || typeof p !== "string" || !p.startsWith("-") || /^--[^=]+=/.test(p) || NO_VALUE_OPTIONS.has(p)) return true;
  }
  return false;
}
const NETWORK_ADDRESS =/^(?!file:\/\/)[A-Za-z][A-Za-z0-9+.-]*:\/\/|^[A-Za-z][A-Za-z0-9+.-]*::|^[^\s/\\@:]+@[^\s/\\:]+:/i;

/** The call's arguments and environment without its askpass and proxy settings (the -c, --config-env and env forms). */
function withoutAskpass(args, env) {
  const out = [];
  let i = 0;
  const isAsk = (kv, envForm = false) => ASKPASS_OR_PROXY.has((envForm ? splitEnvSpec(kv) : splitKv(kv))[0].toLowerCase());
  while (i < args.length && typeof args[i] === "string" && args[i].startsWith("-")) {
    const a = args[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    if (VALUE_GLOBALS.has(name) && inline === undefined) {
      const v = args[i + 1];
      if (!((name === "-c" || name === "--config-env") && v !== undefined && isAsk(v, name === "--config-env"))) out.push(a, ...(v === undefined ? [] : [v]));
      i += 2;
      continue;
    }
    const dropped = (name === "--config-env" && inline !== undefined && isAsk(inline, true)) || (name.startsWith("-c") && name.length > 2 && !name.startsWith("--") && isAsk(name.slice(2)));
    if (!dropped) out.push(a);
    i += 1;
  }
  out.push(...args.slice(i));
  const pairs = envConfigs(env).filter(([k]) => !ASKPASS_OR_PROXY.has(String(k).toLowerCase()));
  const e = { ...env };
  delete e.GIT_CONFIG_PARAMETERS;
  for (const k of Object.keys(e)) if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete e[k];
  if (pairs.length > 0) { e.GIT_CONFIG_COUNT = String(pairs.length); pairs.forEach(([k, v], n) => { e[`GIT_CONFIG_KEY_${n}`] = k; e[`GIT_CONFIG_VALUE_${n}`] = v; }); }
  return { args: out, env: e };
}

/**
 * Whether a refused call is a project test's own (see above): true only when it is refused for an askpass or proxy program
 * alone, in a repository wholly inside `testRoots` (the run's temporary folder) and outside `checkout` (the run's own).
 * `git(args, cwd)` runs the real git and returns its output, or null.
 */
export function inProjectTests(args, { cwd, roots, testRoots, checkout, env, git }) {
  if (!Array.isArray(testRoots) || testRoots.length === 0) return false;
  const g = parseGlobal(args, env);
  const settings = [...g.configs, ...envConfigs(env)];
  let asks = 0;
  for (const [k, v] of settings) {
    if (!protectedSetting(k, v, { cwd, roots })) continue;
    if (!ASKPASS_OR_PROXY.has(String(k).toLowerCase())) return false;
    asks++;
  }
  if (asks === 0) return false;
  return testsOwnCall(args, g, { cwd, roots, testRoots, checkout, env, git });
}

/** The conditions of inProjectTests after the refused settings (shared with goneFolderTests). */
function testsOwnCall(args, g, { cwd, roots, testRoots, checkout, env, git }) {
  if (typeof g.sub !== "string" || !NOT_ALIASES.has(g.sub)) return false;
  // A `..` segment is collapsed by resolve() but taken after any link by the system (`<tmp>/link/../x` with the link into
  // the checkout reaches the checkout): no argument, git folder setting or folder may contain one (W01d follow-up check).
  if (args.some(climbs) || [cwd, env.GIT_DIR, env.GIT_WORK_TREE, env.GIT_COMMON_DIR].some(climbs)) return false;
  // The address may also follow an option's `=` (`--upload-pack=...`, `--reference=...`): read both forms.
  if (args.some((a) => typeof a !== "string" || NETWORK_ADDRESS.test(a) || NETWORK_ADDRESS.test(a.replace(/^--[^=]*=/, "")))) return false;
  const stripped = withoutAskpass(args, env);
  if (decide(stripped.args, { cwd, roots, env: stripped.env, git }).refuse) return false;
  // Where it acts: its folder, any git folder or work tree it names, and the repository's own git folder.
  let dir = cwd;
  for (const d of g.dirs) dir = resolve(dir, d);
  const places = [dir];
  const locator = [];
  for (let i = 0; i < g.globals.length; i++) {
    const a = g.globals[i];
    for (const opt of ["--git-dir", "--work-tree"]) {
      if (a === opt && i + 1 < g.globals.length) { places.push(resolve(dir, g.globals[i + 1])); locator.push(opt, g.globals[i + 1]); }
      else if (a.startsWith(`${opt}=`)) { places.push(resolve(dir, a.slice(opt.length + 1))); locator.push(a); }
    }
  }
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) if (typeof env[k] === "string" && env[k] !== "") places.push(resolve(dir, env[k]));
  // Every address the call can reach is a local folder (W01d review): the repository's own remotes (a remote written into
  // its configuration file directly, not with `git remote`, was not read before) and no URL rewrite in its configuration;
  // and for a subcommand that contacts a remote, every positional argument is one of those remotes or a local path
  // (`github.com:owner/repo`, an ssh address without a user, matched no network pattern). A submodule's addresses come
  // from .gitmodules: never tagged.
  if (g.sub === "submodule") return false;
  // Nor any call that may recurse into submodules (their addresses come from .gitmodules and submodule.*.url, not read
  // here): a --recurse-submodules/--recursive option (the worker's --no-recurse-submodules is fine), or a submodule or recursion setting (W01d second review).
  // git accepts any unambiguous abbreviation of a long option (`--recurse-sub`), so every `--rec...` option counts (W01d final check).
  if (args.some((a) => typeof a === "string" && /^--rec/.test(a))) return false;
  const callGlobals = []; // the call's own global options without -C (its folder is already `dir`), so its -c values count
  for (let i = 0; i < g.globals.length; i++) { if (g.globals[i] === "-C") { i++; continue; } callGlobals.push(g.globals[i]); }
  const configured = (git([...callGlobals, "config", "--get-regexp", "^(remote\\..*\\.(push)?url|url\\..*|branch\\..*\\.(push)?remote|remote\\.pushdefault|submodule\\..*|.*\\.recursesubmodules)$"], dir) ?? "").split(/\r?\n/).filter(Boolean);
  const tests = testRoots.map((r) => realish(r));
  const own = typeof checkout === "string" && checkout !== "" ? [realish(checkout)] : [];
  // A local address counts only when it lies in the run's temporary folder and outside its checkout: a fetch, clone or push
  // between a scratch repository and the checkout or another checkout is not the tests' own (W01d second review).
  const testLocal = (u) => { if (climbs(u)) return false; const p = localPath(u, dir); return p !== null && inside(p, tests) && !inside(p, own); };
  const remoteNames = new Set();
  const named = []; // a branch's remote: a remote's name or an address of its own
  let fetchRecurseOff = false; // submodule.recurse or fetch.recurseSubmodules set to false
  for (const line of configured) {
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? "" : line.slice(sp + 1);
    // A URL rewrite may send a local path to the network; one to the bench's refused address (the run's own git settings
    // rewrite GitHub there, on every call) reaches nothing, so it is not one (W01d final re-check).
    if (/^url\./i.test(key)) { const m = /^url\.(.*)\.(?:push)?insteadof$/i.exec(key); if (m !== null && m[1] === REFUSED_ADDRESS) continue; return false; }
    // A submodule's own entry (submodule.<name>.url, ...) or recursion turned on; the worker's submodule.recurse=false is fine.
    if (/^submodule\.recurse$|\.recursesubmodules$/i.test(key)) {
      if (!/^(?:false|no|off|0)$/i.test(value)) return false;
      if (/^(?:submodule\.recurse|fetch\.recursesubmodules)$/i.test(key)) fetchRecurseOff = true;
      continue;
    }
    if (/^submodule\./i.test(key)) return false;
    if (/^branch\.|^remote\.pushdefault$/i.test(key)) { named.push(value); continue; }
    if (!testLocal(value)) return false;
    remoteNames.add(key.replace(/^remote\./i, "").replace(/\.(?:push)?url$/i, ""));
  }
  if (named.some((v) => !remoteNames.has(v) && !testLocal(v))) return false;
  // fetch and pull recurse "on demand" by default, which also reaches a populated submodule with its own .git folder (no
  // modules/ folder to see): tagged only with recursion turned off, as the worker always does (W01d final check).
  if ((g.sub === "fetch" || g.sub === "pull") && !fetchRecurseOff && !noRecurseOption(g.rest)) return false;
  if (REMOTE_SUBS.has(g.sub)) {
    if (g.rest.some((a) => /^--remote(?:=|$)/.test(a))) return false; // archive --remote
    if (g.rest.some((a) => !a.startsWith("-") && !remoteNames.has(a) && !testLocal(a))) return false;
    // An option's own value after `=` (`--reference=<path>`, `--separate-git-dir=<path>`): a path outside, or an address.
    if (g.rest.some((a) => /^--[^=]+=./.test(a) && !testLocal(a.slice(a.indexOf("=") + 1)))) return false;
  }
  const common = git([...locator, "rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
  if (common !== null && common.trim() !== "") {
    places.push(common.trim());
    if (existsSync(join(common.trim(), "modules"))) return false; // a repository with submodules checked out
  }
  return places.every((p) => { const r = realish(p); return inside(r, tests) && !inside(r, own); });
}

/** Whether a path names a `..` segment (also percent-encoded, as in a file:// URL). */
function climbs(p) {
  if (typeof p !== "string") return false;
  let d = p;
  try { d = decodeURIComponent(p); } catch { /* not encoded */ }
  return [p, d].some((s) => /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(s));
}

/** The folders a call acts in: its folder after -C, and any --git-dir, --work-tree, GIT_DIR, GIT_WORK_TREE or GIT_COMMON_DIR. */
function callPlaces(g, cwd, env) {
  let dir = cwd;
  for (const d of g.dirs) dir = resolve(dir, d);
  const places = [dir];
  for (let i = 0; i < g.globals.length; i++) {
    const a = g.globals[i];
    for (const opt of ["--git-dir", "--work-tree"]) {
      if (a === opt && i + 1 < g.globals.length) places.push(resolve(dir, g.globals[i + 1]));
      else if (a.startsWith(`${opt}=`)) places.push(resolve(dir, a.slice(opt.length + 1)));
    }
  }
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) if (typeof env[k] === "string" && env[k] !== "") places.push(resolve(dir, env[k]));
  return places;
}

// ---- a call from a folder that no longer exists (W01d follow-up) ----
// A worker test can remove its temporary folder while one of its git calls is starting; that call's folder cannot be read
// (process.cwd() throws), so nothing about it can be decided and it is refused (kind GONE_FOLDER). Its last known folder
// is the one the system kept (Linux: /proc/self/cwd reads `<path> (deleted)`, which the caller cannot set); only where that
// cannot be read, PWD (the shell's). It is tagged as the tests' own only when all of these hold, with that folder standing in:
//   - it is an absolute path that no longer exists, inside the run's temporary folder and outside its checkout;
//   - every folder the call acts in (its folder after -C, --git-dir, --work-tree, GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR)
//     no longer exists either, and lies in the run's temporary folder outside its checkout: there is no repository left
//     for it to read or change;
//   - every other condition of inProjectTests holds with PWD as its folder: no refused setting other than an askpass or
//     proxy program or protocol.allow, the subcommand named directly, no network address, no submodule or recursion, every
//     address a local folder in the temporary folder. The refused-askpass condition itself is not needed: the folder being
//     gone is the reason for the refusal.
// Any other call whose folder is gone is refused and counted. The limit: where PWD is used, it is the caller's to set, so an
// agent whose own folder is gone could name a gone folder in the temporary folder; such a call is refused and has no
// repository to touch.
export const GONE_FOLDER = "gone-folder";
/** The last known folder of a process whose folder is gone: the system's record (Linux), else PWD; or null. */
export function lastKnownFolder(env = process.env, procCwd = "/proc/self/cwd") {
  try {
    const link = readlinkSync(procCwd);
    return link.endsWith(" (deleted)") ? link.slice(0, -" (deleted)".length) : null;
  } catch { /* no /proc (macOS, Windows): PWD */ }
  return typeof env.PWD === "string" ? env.PWD : null;
}

export function goneFolderTests(args, { pwd, roots, testRoots, checkout, env, git }) {
  if (!Array.isArray(testRoots) || testRoots.length === 0) return false;
  if (typeof pwd !== "string" || !isAbsolute(pwd) || climbs(pwd) || existsSync(pwd)) return false;
  const g = parseGlobal(args, env);
  const tests = testRoots.map((r) => realish(r));
  const own = typeof checkout === "string" && checkout !== "" ? [realish(checkout)] : [];
  const ok = (p) => { if (existsSync(p)) return false; const r = realish(p); return inside(r, tests) && !inside(r, own); };
  if (!ok(pwd) || !callPlaces(g, pwd, env).every(ok)) return false;
  return testsOwnCall(args, g, { cwd: pwd, roots, testRoots, checkout, env, git });
}

/**
 * The guard log, counted: `counted` refusals (contamination) and `inProjectTests` (tagged as a project test's own, reported
 * apart). Only a line of exactly the tagged form is left out; any other line with " refused " counts.
 */
export function guardLogCounts(text) {
  let counted = 0, tests = 0;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.includes(" refused ")) continue;
    if (/^\S+ refused (?:setting|gone-folder) in-project-tests$/.test(line)) tests++; else counted++;
  }
  return { counted, inProjectTests: tests };
}

const STRIP = ["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_PROXY_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "SSH_AUTH_SOCK"];

function main() {
  const [cfgPath, ...args] = process.argv.slice(2);
  let cfg;
  try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { process.stderr.write("git: the bench's git settings could not be read; git is disabled\n"); process.exit(1); }
  const env = { ...process.env };
  for (const k of STRIP) delete env[k];
  // The run's own git settings, whatever the caller set: GIT_CONFIG_GLOBAL=/dev/null or GIT_CONFIG_NOSYSTEM=1 would drop
  // the rules that send nothing out.
  if (typeof cfg.gitConfig === "string") { env.GIT_CONFIG_GLOBAL = cfg.gitConfig; env.GIT_CONFIG_SYSTEM = cfg.gitConfig; }
  delete env.GIT_CONFIG_NOSYSTEM;
  const runGit = (a, cwd) => { const r = spawnSync(cfg.realGit, a, { cwd, env, encoding: "utf8" }); return r.status === 0 ? r.stdout : null; };
  // The folder is read once (W01d follow-up): when it no longer exists, the call is refused (see goneFolderTests).
  let cwd = null;
  try { cwd = process.cwd(); } catch { /* the folder is gone */ }
  let d;
  if (cwd === null) d = { refuse: "this git command's folder no longer exists; it is disabled in this environment", kind: GONE_FOLDER };
  else {
    try { d = decide(args, { cwd, roots: cfg.allowRoots, env, git: runGit }); } catch { d = { refuse: "this git command could not be checked; it is disabled in this environment", kind: "unchecked" }; }
  }
  if (d.refuse) {
    let tag = "";
    try {
      const tc = { roots: cfg.allowRoots, testRoots: cfg.testRoots, checkout: cfg.checkout, env, git: runGit };
      if (d.kind === "setting" && inProjectTests(args, { ...tc, cwd })) tag = ` ${IN_PROJECT_TESTS}`;
      else if (d.kind === GONE_FOLDER && goneFolderTests(args, { ...tc, pwd: lastKnownFolder() })) tag = ` ${IN_PROJECT_TESTS}`;
    } catch { /* not shown to be a test's own: counted */ }
    try { appendFileSync(cfg.log, `${new Date().toISOString()} refused ${d.kind}${tag}\n`); } catch { /* the log is best effort */ }
    process.stderr.write(`git: ${d.refuse}\n`);
    process.exit(1);
  }
  const r = spawnSync(cfg.realGit, args, { stdio: "inherit", env });
  if (r.error) { process.stderr.write(`git: ${r.error.message}\n`); process.exit(127); }
  if (r.signal) process.kill(process.pid, r.signal);
  process.exit(r.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
