// The agent's isolation (W01 follow-up "w01iso", after a bench agent added a GitHub remote, tried to push and listed the
// owner's ~/.ssh and ~/.git-credentials during a measured batch). Every agent the bench starts gets:
//   - a fresh, empty home folder of its own (HOME, USERPROFILE, XDG_* and TMPDIR all point into a per-run temporary folder,
//     removed at the end of the run, --keep or not), holding only what Pi needs to reach the model route;
//   - an environment rebuilt from an allowlist (no SSH_AUTH_SOCK, GIT_*, GH_TOKEN, cloud or npm tokens, no *_KEY / *_TOKEN /
//     *_SECRET name);
//   - git settings of its own (GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM): ssh disabled, GitHub addresses rewritten to a
//     refused local address, network transports not allowed (local folders are), no credential helper, push.default
//     nothing; and a `git` first on its PATH (lib/git-guard.mjs) that refuses a push except into the run's own folders,
//     a remote that is not a local folder, and settings that would loosen the above;
//   - on Linux, when bubblewrap works: the owner's home folder, the user's runtime folder (ssh-agent and keyring sockets)
//     and /srv/ai hidden behind empty folders, its own process list (other processes' environments and /proc/<pid>/root
//     out of reach), the bench's git settings and wrapper mounted read-only. The network is NOT cut off (the agent must
//     reach the model server on the host's loopback address; a network namespace would cut that too).
//   - the model key is not given to the agent at all: Pi's per-run configuration points at a loopback proxy the bench runs
//     for the length of the run, which adds the key to each request. The key is read from the owner's Pi configuration by
//     the bench only, never written into the agent's home, never printed or logged.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
/** The git wrapper program put first on the agent's PATH. */
export const GIT_GUARD = fileURLToPath(new URL("./git-guard.mjs", import.meta.url));
/** What the agent reads when it tries to push. */
export const PUSH_REFUSED = "pushing is disabled in this environment";
/** Where GitHub addresses are sent instead: loopback port 9 over http, which the agent's git settings do not allow anyway. */
export const REFUSED_ADDRESS = "http://127.0.0.1:9/pushing-is-disabled/";

// ---- environment ----

const KEEP_NAMES = new Set(["PATH", "Path", "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "USER", "LOGNAME", "NODE_OPTIONS", "NODE_ENV", "CI",
  "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "COMSPEC", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"]);
/** The bench's own settings (its agents' modes, the run mark) and NimbleNewt's test switches pass; locale too. */
const KEEP_PREFIXES = ["LC_", "PI_EVAL_", "STUB_AGENT_", "FAKE_CLAUDE_", "CLAUDE_AGENT_", "NIMBLENEWT_"];
/** A name that looks like it holds a credential is dropped even under a kept prefix. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|COOKIE|PRIVATE/i;

/** The agent's environment from `source`: only allowlisted names, never one that looks like a credential. */
export function scrubEnv(source = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v !== "string") continue;
    if (!(KEEP_NAMES.has(k) || KEEP_PREFIXES.some((p) => k.startsWith(p)))) continue;
    if (SECRET_NAME.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// ---- git settings ----

/** The agent's global and system git settings. */
export function gitConfigText() {
  const github = ["https://github.com/", "http://github.com/", "git@github.com:", "ssh://git@github.com/", "git://github.com/"];
  return [
    "# The bench's git settings for an agent run (scripts/pi-eval/lib/isolation.mjs). Pushing is disabled in this environment.",
    "[user]", "\tname = Pi eval agent", "\temail = pi-eval@localhost",
    "[core]", `\tsshCommand = ${IS_WIN ? "false" : "/bin/false"}`,
    "[credential]", "\thelper =",
    "[push]", "\tdefault = nothing",
    "[protocol]", "\tallow = never",
    "[protocol \"file\"]", "\tallow = always",
    `[url "${REFUSED_ADDRESS}"]`, ...github.map((g) => `\tinsteadOf = ${g}`), ...github.map((g) => `\tpushInsteadOf = ${g}`),
    "",
  ].join("\n");
}

// ---- the model route: a per-run Pi configuration and the key proxy ----

/**
 * The owner's Pi provider entry (from <ownerHome>/.pi/agent/models.json), or null when there is none. Errors name the path
 * only: a JSON parse error quotes the text around the fault, which may be the key.
 */
export function ownerProvider(ownerHome, provider) {
  const file = join(ownerHome, ".pi", "agent", "models.json");
  if (!existsSync(file)) return null;
  let models;
  try { models = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`Pi's models.json (${file}) could not be read as JSON${e?.code ? ` (${e.code})` : ""}`); }
  const p = models?.providers?.[provider];
  if (!p || typeof p !== "object") return null;
  if (typeof p.apiKey !== "string" || p.apiKey === "" || typeof p.baseUrl !== "string") return null;
  return p;
}

/** The provider entry the agent gets: the owner's, without the key or any header or credential field, pointing at the proxy. */
export function agentProviderEntry(entry, proxyBaseUrl) {
  const out = {};
  for (const [k, v] of Object.entries(entry)) if (!/key|token|secret|header|auth|cred/i.test(k)) out[k] = v;
  return { ...out, baseUrl: proxyBaseUrl, apiKey: "pi-eval-local-proxy" };
}

/**
 * A loopback proxy to the model server for one run: it forwards requests under the base URL's path and puts the key in
 * the Authorization header (whatever the agent sent there is dropped). Nothing is logged; an upstream failure answers 502
 * with a fixed text. Resolves { baseUrl, close() }.
 */
export function startKeyProxy({ upstreamBaseUrl, apiKey }) {
  const up = new URL(upstreamBaseUrl);
  const basePath = up.pathname.replace(/\/+$/, "");
  const mod = up.protocol === "https:" ? https : http;
  const server = http.createServer((req, res) => {
    const url = String(req.url ?? "");
    if (!(url === basePath || url.startsWith(`${basePath}/`) || basePath === "")) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found\n"); req.resume(); return; }
    const headers = { ...req.headers };
    for (const h of ["host", "authorization", "proxy-authorization", "connection", "keep-alive"]) delete headers[h];
    headers.authorization = `Bearer ${apiKey}`;
    const preq = mod.request({ protocol: up.protocol, hostname: up.hostname, port: up.port, method: req.method, path: url, headers }, (pres) => {
      const h = { ...pres.headers };
      delete h.connection; delete h["keep-alive"];
      res.writeHead(pres.statusCode ?? 502, h);
      pres.pipe(res);
    });
    preq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("pi-eval proxy: the model server could not be reached\n");
    });
    res.on("close", () => { if (!res.writableFinished) preq.destroy(); });
    req.pipe(preq);
  });
  return new Promise((resolveP, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveP({
        baseUrl: `http://127.0.0.1:${port}${basePath}`,
        close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
      });
    });
  });
}

// ---- hiding the owner's folders (Linux, bubblewrap) ----

const usable = new Map();
/** Whether bubblewrap can start a process here with the namespaces the bench uses (probed once per path). */
export function sandboxUsable(bwrap = "bwrap") {
  if (process.platform !== "linux" || !bwrap) return false;
  if (!usable.has(bwrap)) {
    const r = spawnSync(bwrap, ["--dev-bind", "/", "/", "--unshare-pid", "--unshare-ipc", "--proc", "/proc", "--tmpfs", "/mnt", "--", "/bin/true"], { stdio: "ignore", timeout: 10_000 });
    usable.set(bwrap, r.status === 0);
  }
  return usable.get(bwrap);
}

/** The folders hidden from the agent: the owner's home (and this process's), the runtime folder of sockets, /srv/ai, extras. */
export function defaultHidden({ ownerHome = homedir(), extra = [] } = {}) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const list = [ownerHome, homedir(), process.env.XDG_RUNTIME_DIR, uid === null ? null : `/run/user/${uid}`, "/srv/ai", ...extra];
  return [...new Set(list.filter((p) => typeof p === "string" && isAbsolute(p)).map((p) => resolve(p)))].filter((p) => p !== sep && existsSync(p));
}

const under = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** The folder a program's whole install lives in: the parent of its outermost node_modules, else its own folder. */
export function installRoot(file) {
  const parts = real(file).split(sep);
  const i = parts.indexOf("node_modules");
  return i > 0 ? parts.slice(0, i).join(sep) || sep : dirname(real(file));
}

/**
 * The bubblewrap command prefix: the whole file system as it is, then each hidden folder covered by an empty one (a hidden
 * file by /dev/null), then the run's own folders bound back writable and the programs it needs bound back read-only where
 * they lie under a hidden folder, then the bench's own settings read-only. A process list of its own (with its own /proc)
 * and IPC; the network is shared (the model server is on the host's loopback address).
 */
export function bwrapPrefix({ bwrap = "bwrap", hidden, writable = [], readable = [], readOnly = [] }) {
  const argv = [bwrap, "--dev-bind", "/", "/", "--unshare-pid", "--unshare-ipc", "--proc", "/proc", "--die-with-parent"];
  for (const h of [...hidden].sort((a, b) => a.length - b.length)) {
    let isDir = true;
    try { isDir = statSync(h).isDirectory(); } catch { continue; }
    argv.push(...(isDir ? ["--tmpfs", h] : ["--ro-bind", "/dev/null", h]));
  }
  const back = [...writable.map((p) => [p, "--bind"]), ...readable.map((p) => [p, "--ro-bind"])]
    .filter(([p]) => existsSync(p) && hidden.some((h) => under(resolve(p), h) || under(real(p), h)))
    .sort((a, b) => a[0].length - b[0].length);
  for (const [p, how] of back) argv.push(how, p, p);
  for (const p of readOnly) if (existsSync(p)) argv.push("--ro-bind", p, p);
  argv.push("--");
  return argv;
}

// ---- the per-run folder ----

/**
 * Makes one run's isolation: a temporary folder holding the agent's home, temp folder, git settings and git wrapper, and,
 * when the owner's Pi configuration has the run's provider, a per-run Pi configuration that reaches the model server
 * through the key proxy. Returns { base, home, env, allowRoots, readOnly, providerProxied, close() } (close stops the proxy
 * and removes the folder).
 */
export async function prepareIsolation({ checkoutDir, artifactsDir, ownerHome = homedir(), provider, model, realGit, piBin, sourceEnv = process.env, tmpRoot = tmpdir() }) {
  const base = mkdtempSync(join(tmpRoot, "pi-eval-iso-"));
  let proxy = null;
  const close = async () => { try { await proxy?.close(); } catch { /* already closed */ } await rm(base, { recursive: true, force: true }).catch(() => {}); };
  try {
    const home = join(base, "home");
    const xdg = { XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state") };
    for (const d of [home, ...Object.values(xdg), join(base, "tmp"), join(base, "bin")]) mkdirSync(d, { recursive: true });
    const gitconfig = join(base, "gitconfig");
    writeFileSync(gitconfig, gitConfigText());
    // A git that ignores GIT_CONFIG_GLOBAL (or an agent that unsets it) reads ~/.gitconfig: the same settings.
    writeFileSync(join(home, ".gitconfig"), gitConfigText());
    const allowRoots = [...new Set([checkoutDir, base].map(real))];
    const guardConfig = join(base, "bin", "git-guard.json");
    // The refusals of this run only (two runs started in the same second share a run ID and so an artifacts folder).
    rmSync(join(artifactsDir, "git-guard.log"), { force: true });
    writeFileSync(guardConfig, JSON.stringify({ realGit, allowRoots, log: join(artifactsDir, "git-guard.log") }));
    const node = process.execPath;
    if (IS_WIN) writeFileSync(join(base, "bin", "git.cmd"), `@"${node}" "${GIT_GUARD}" "${guardConfig}" %*\r\n`);
    else {
      writeFileSync(join(base, "bin", "git"), `#!/bin/sh\nexec "${node}" "${GIT_GUARD}" "${guardConfig}" "$@"\n`);
      chmodSync(join(base, "bin", "git"), 0o755);
    }
    let providerProxied = false;
    const entry = provider ? ownerProvider(ownerHome, provider) : null;
    if (entry) {
      proxy = await startKeyProxy({ upstreamBaseUrl: entry.baseUrl, apiKey: entry.apiKey });
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      const write = (name, obj) => { writeFileSync(join(agentDir, name), `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 }); chmodSync(join(agentDir, name), 0o600); };
      write("models.json", { providers: { [provider]: agentProviderEntry(entry, proxy.baseUrl) } });
      write("settings.json", { defaultProvider: provider, ...(model ? { defaultModel: model, enabledModels: [`${provider}/${model}`] } : {}) });
      write("auth.json", {});
      providerProxied = true;
    }
    const scrubbed = scrubEnv(sourceEnv);
    const pathName = IS_WIN && scrubbed.Path !== undefined && scrubbed.PATH === undefined ? "Path" : "PATH";
    const env = {
      ...scrubbed,
      [pathName]: [join(base, "bin"), scrubbed[pathName]].filter(Boolean).join(delimiter),
      HOME: home, USERPROFILE: home, ...xdg,
      TMPDIR: join(base, "tmp"), TMP: join(base, "tmp"), TEMP: join(base, "tmp"),
      GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_SYSTEM: gitconfig, GIT_TERMINAL_PROMPT: "0",
      ...(existsSync("/bin/bash") ? { SHELL: "/bin/bash" } : {}),
      ...(piBin ? { PI_EVAL_PI_BIN: piBin } : {}),
    };
    // Read-only inside the sandbox: the agent cannot change the bench's git settings or its wrapper. (Pi's own folder stays
    // writable: Pi may write there, and it holds no key.)
    const readOnly = [join(base, "bin"), gitconfig, join(home, ".gitconfig")];
    return { base, home, env, allowRoots, readOnly, providerProxied, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** The real git program (the first `git` on PATH that is not a run's wrapper), resolved once. */
export function findRealGit(pathValue = process.env.PATH ?? process.env.Path ?? "") {
  const names = IS_WIN ? ["git.exe"] : ["git"];
  for (const d of pathValue.split(delimiter)) {
    if (!d || /pi-eval-iso-/.test(d)) continue;
    for (const n of names) { const p = join(d, n); try { if (statSync(p).isFile()) return real(p); } catch { /* next */ } }
  }
  return IS_WIN ? "git.exe" : "/usr/bin/git";
}

// ---- detection in the agent's log ----

const GIT = String.raw`(?<![\w.-])git(?:\.exe)?`;
const GIT_OPTS = String.raw`(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[A-Za-z][\w-]*(?:=\S+)?))*`;
const PATTERNS = {
  push: new RegExp(`${GIT}${GIT_OPTS}\\s+(?:push|send-pack|http-push)\\b`),
  remote: new RegExp(`${GIT}${GIT_OPTS}\\s+remote(?:\\s+-\\S+)*\\s+(?:add|set-url)\\b|${GIT}\\b[^;&|\\n]*\\bconfig\\b[^;&|\\n]*\\bremote\\.[^\\s.]+\\.(?:push)?url\\b`, "i"),
  credentials: /(?:^|[^\w])\.ssh(?:[/\\"'\s]|$)|\.git-credentials\b|(?<![\w-])id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?\b|\.netrc\b|\bgh-token\b|\.config\/gh\b|SSH_AUTH_SOCK|openssh_agent|\bssh-add\b|\.pi[/\\]agent\b/,
};
/** Fields of a tool call that hold file content, not a command or a path: never searched (code may talk about pushing). */
const CONTENT_FIELDS = new Set(["content", "newText", "oldText", "new_string", "old_string", "edits", "text"]);

/**
 * What the agent's tool calls (summary.toolCommands: each the JSON of one call's arguments) show it tried: `push` (a git
 * push), `remote` (adding or changing a remote), `credentials` (a path or socket of the owner's keys and logins: ~/.ssh,
 * .git-credentials, id_*, .netrc, the gh token, SSH_AUTH_SOCK, Pi's own configuration). Returns the kinds seen, sorted.
 * Detection only: a command assembled at run time is not seen.
 */
export function credentialAttempts(commands) {
  const found = new Set();
  for (const raw of commands) {
    let args = null;
    try { args = JSON.parse(raw); } catch { /* cut at its size limit: searched as it is */ }
    const commandTexts = [], pathTexts = [];
    if (args && typeof args === "object") {
      for (const [k, v] of Object.entries(args)) {
        if (typeof v !== "string" || CONTENT_FIELDS.has(k)) continue;
        if (k === "command" || k === "cmd" || k === "script") commandTexts.push(v); else pathTexts.push(v);
      }
    } else commandTexts.push(String(raw));
    for (const c of commandTexts) for (const [kind, re] of Object.entries(PATTERNS)) if (re.test(c)) found.add(kind);
    for (const p of pathTexts) if (PATTERNS.credentials.test(p)) found.add("credentials");
  }
  return [...found].sort();
}
