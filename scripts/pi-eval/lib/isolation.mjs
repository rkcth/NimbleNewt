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
//   - on Linux, when bubblewrap works: the whole file system read-only; the owner's home folder, /srv/ai, the team's and
//     the test database's key folders, and credential-like files and owner-only folders in what stays readable hidden
//     behind empty ones; /tmp, /var/tmp, /run and /dev/shm private (empty, its own); a minimal /dev; its own process
//     list (other processes' environments and /proc/<pid>/root out of reach); and its own network namespace with only a
//     loopback device, where a bridge (lib/net-bridge.mjs) is the one way out: to the bench's key proxy.
//   - the model key is not given to the agent at all: Pi's per-run configuration points at the bench's proxy (through the
//     bridge in the sandbox, or at 127.0.0.1 without one), run for the length of the run, which adds the key to each
//     request. The key is read from the owner's Pi configuration by the bench only, never written into the agent's home,
//     never printed or logged.
import { spawnSync } from "node:child_process";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { Transform } from "node:stream";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { REFUSED_ADDRESS, splitAlias } from "./git-guard.mjs";
import { toolCallTexts, wholePart } from "./tool-args.mjs";

const IS_WIN = process.platform === "win32";
/** The git wrapper program put first on the agent's PATH. */
export const GIT_GUARD = fileURLToPath(new URL("./git-guard.mjs", import.meta.url));
/** What the agent reads when it tries to push. */
export const PUSH_REFUSED = "pushing is disabled in this environment";
/** Where GitHub addresses are sent instead (defined in git-guard.mjs, which reads the bench's own rewrite to it). */
export { REFUSED_ADDRESS };

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

/** The placeholder key's prefix: the agent's per-run configuration holds this and the run's proxy token, never the key. */
export const PROXY_KEY_PREFIX = "pi-eval-local-proxy-";

/**
 * The provider entry the agent gets: the owner's, without the key or any header or credential field, pointing at the
 * proxy, with the run's proxy token as its key (the proxy answers only requests that carry it).
 */
export function agentProviderEntry(entry, proxyBaseUrl, token) {
  const out = {};
  for (const [k, v] of Object.entries(entry)) if (!/key|token|secret|header|auth|cred/i.test(k)) out[k] = v;
  return { ...out, baseUrl: proxyBaseUrl, apiKey: token };
}

/** The only requests the proxy forwards (method and path under the base URL): what Pi's OpenAI-style route uses. */
const PROXY_ROUTES = [["POST", "/chat/completions"], ["GET", "/models"]];
/** A request body larger than this is refused (413) and not forwarded further. */
export const PROXY_MAX_BODY = 64 * 1024 * 1024;

/**
 * A stream filter that replaces every occurrence of `secret` with a fixed text, also across chunk boundaries (the last
 * end of a chunk that could be the secret's start is held back until the next chunk or the end). Used on the model server's answers, so a server
 * that echoes the request's headers in an error body cannot hand the key to the agent.
 */
export function redactStream(secret, replacement = "[key withheld by the pi-eval proxy]") {
  const s = Buffer.from(secret);
  const r = Buffer.from(replacement);
  let held = Buffer.alloc(0);
  const scrub = (buf) => {
    const parts = [];
    let from = 0;
    for (let i = buf.indexOf(s); i >= 0; i = buf.indexOf(s, from)) { parts.push(buf.subarray(from, i), r); from = i + s.length; }
    parts.push(buf.subarray(from));
    return Buffer.concat(parts);
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      const all = scrub(Buffer.concat([held, Buffer.from(chunk)]));
      // Hold back only a tail that could be the start of the secret (so a stream is not delayed otherwise).
      let keep = 0;
      for (let k = Math.min(all.length, s.length - 1); k > 0; k--) if (all.subarray(all.length - k).equals(s.subarray(0, k))) { keep = k; break; }
      held = all.subarray(all.length - keep);
      cb(null, all.subarray(0, all.length - keep));
    },
    flush(cb) { cb(null, scrub(held)); },
  });
}

/**
 * A proxy to the model server for one run: it forwards only the model route's requests (PROXY_ROUTES, the exact path, no
 * query) that carry the run's token (`Authorization: Bearer <token>`, a fresh random value per run, so another local
 * process or another run cannot borrow the key through it), and puts the key in the Authorization header instead.
 * Anything else answers 404 or 401 and is not forwarded. It listens on `socketPath` (a unix socket, which the sandbox's
 * bridge reaches from inside a network namespace of its own) or else on 127.0.0.1, a random port. Bodies over
 * PROXY_MAX_BODY answer 413; at most `maxConnections` at once; the key is cut out of every answer (headers and body), so
 * a server that echoes request headers cannot leak it. Nothing is logged; an upstream failure answers 502 with a fixed
 * text (or, once an answer has started, ends the connection); redirects are passed back, never followed. Resolves
 * { baseUrl (TCP only), socketPath, basePath, token, close() }.
 */
export function startKeyProxy({ upstreamBaseUrl, apiKey, token = PROXY_KEY_PREFIX + randomBytes(24).toString("hex"), socketPath = null, maxBody = PROXY_MAX_BODY, maxConnections = 32 }) {
  const up = new URL(upstreamBaseUrl);
  const basePath = up.pathname.replace(/\/+$/, "");
  const mod = up.protocol === "https:" ? https : http;
  const want = Buffer.from(`Bearer ${token}`);
  // A fresh connection to the model server for every request: a kept-alive one that the server closes as the next request
  // goes out answers that request with a connection reset (seen as a rare failure of the real-Pi test under load), and
  // would end a measured run as an error.
  const agent = new mod.Agent({ keepAlive: false });
  const server = http.createServer((req, res) => {
    const url = String(req.url ?? "");
    const refuse = (code, text) => { res.writeHead(code, { "content-type": "text/plain", connection: "close" }); res.end(`${text}\n`); req.resume(); };
    if (!PROXY_ROUTES.some(([m, p]) => req.method === m && url === `${basePath}${p}`)) { refuse(404, "not found"); return; }
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    if (got.length !== want.length || !timingSafeEqual(got, want)) { refuse(401, "unauthorized"); return; }
    if (Number(req.headers["content-length"] ?? 0) > maxBody) { refuse(413, "request too large"); return; }
    const headers = { ...req.headers };
    for (const h of ["host", "authorization", "proxy-authorization", "connection", "keep-alive", "upgrade", "te", "trailer", "proxy-connection"]) delete headers[h];
    headers.authorization = `Bearer ${apiKey}`;
    // Answers uncompressed only: the key is cut out of the bytes as sent, which a compressed answer would hide.
    headers["accept-encoding"] = "identity";
    let answered = false;
    const preq = mod.request({ protocol: up.protocol, hostname: up.hostname, port: up.port, method: req.method, path: url, headers, agent }, (pres) => {
      answered = true;
      // A compressed answer (sent although identity was asked for) could carry the key unseen: it is not passed on.
      const enc = String(pres.headers["content-encoding"] ?? "").trim().toLowerCase();
      if (enc !== "" && enc !== "identity") { pres.resume(); res.writeHead(502, { "content-type": "text/plain", connection: "close" }); res.end("pi-eval proxy: the model server sent a compressed answer\n"); return; }
      const h = {};
      for (const [k, v] of Object.entries(pres.headers)) {
        if (k === "connection" || k === "keep-alive" || k === "content-length") continue; // the length changes if the key is cut out
        if ([v].flat().some((x) => String(x).includes(apiKey))) continue;
        h[k] = v;
      }
      res.writeHead(pres.statusCode ?? 502, h);
      pres.on("error", () => res.destroy());
      pres.on("aborted", () => res.destroy());
      pres.pipe(redactStream(apiKey)).pipe(res);
    });
    preq.on("error", () => {
      // Before an answer: a fixed text. Mid-answer (a stream cut short): the connection ends, nothing is appended to it.
      if (!answered && !res.headersSent) { res.writeHead(502, { "content-type": "text/plain", connection: "close" }); res.end("pi-eval proxy: the model server could not be reached\n"); } else res.destroy();
    });
    res.on("close", () => { if (!res.writableFinished) preq.destroy(); });
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBody) { preq.destroy(); req.unpipe(preq); if (!res.headersSent) refuse(413, "request too large"); else res.destroy(); }
    });
    req.pipe(preq);
  });
  server.maxConnections = maxConnections;
  // A client that ends its side of the connection after its request (a half-close) still gets the answer.
  server.httpAllowHalfOpen = true;
  server.headersTimeout = 30_000;
  // Longer than any client's own idle limit, so the client, not the proxy, closes an idle connection (no request is sent on
  // a connection the proxy is closing).
  server.keepAliveTimeout = 65_000;
  return new Promise((resolveP, reject) => {
    server.once("error", reject);
    const done = () => {
      // The socket for this user only (its folder, the per-run one, is this user's only too).
      if (socketPath) { try { chmodSync(socketPath, 0o600); } catch (e) { server.close(); reject(e); return; } }
      const port = socketPath ? null : server.address().port;
      resolveP({
        baseUrl: port === null ? null : `http://127.0.0.1:${port}${basePath}`, socketPath, basePath, token,
        close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); agent.destroy(); }),
      });
    };
    if (socketPath) server.listen(socketPath, done); else server.listen(0, "127.0.0.1", done);
  });
}

// ---- hiding the owner's folders (Linux, bubblewrap) ----

const usable = new Map();
/** Whether bubblewrap can start a process here with the namespaces and mounts the bench uses (probed once per path). */
export function sandboxUsable(bwrap = "bwrap") {
  if (process.platform !== "linux" || !bwrap) return false;
  if (!usable.has(bwrap)) {
    const r = spawnSync(bwrap, ["--ro-bind", "/", "/", "--dev", "/dev", "--tmpfs", "/tmp", "--unshare-pid", "--unshare-ipc", "--unshare-net", "--proc", "/proc", "--", "/bin/true"], { stdio: "ignore", timeout: 10_000 });
    usable.set(bwrap, r.status === 0);
  }
  return usable.get(bwrap);
}

/**
 * The folders the agent gets an empty, private copy of (a fresh tmpfs, gone with the run): the host's /tmp and /var/tmp
 * (other programs' scratch files, the per-user socket folders of ssh-agent, tmux, screen, the Codex daemon and the Claude
 * Code driver, the database servers' sockets, the X server's, and scripts the owner runs later such as /tmp/nn-slot.sh,
 * which the agent could otherwise rewrite), /run (every system socket: the container engine's, whose group can mount the
 * owner's home in a container; the user's runtime folder with ssh-agent, keyring, gpg-agent and D-Bus; tailscale,
 * containerd, the system bus), /dev/shm (other processes' shared memory, such as the database servers' buffers) and
 * /var/log (the system's logs: the agent keeps its user's supplementary groups, see bwrapPrefix, and the adm group reads
 * the system log, the login log and the journal). Anything of the run's own under them is bound back.
 */
export const PRIVATE_DIRS = ["/tmp", "/var/tmp", "/run", "/dev/shm", "/var/log"];

/**
 * The system's folders searched at each run's start for unix sockets and for what only a supplementary group may read
 * (credentialPaths with byName off): a socket outside /run (such as a snap's root service socket under /var/snap) is
 * reachable from any network namespace, and the agent keeps its user's groups (adm, dip, docker, ...).
 */
export const SYSTEM_ROOTS = ["/etc", "/var", "/opt", "/srv", "/mnt", "/media", "/usr/local", "/boot"];

/**
 * This machine's other places holding keys and logins, hidden where they exist: /srv/ai (model files, other projects'
 * keys and .env files), the team's folder (/srv/code/team: its `secrets` holds SSH deploy and server keys, its `private`
 * tokens) and the test database's credentials (/srv/code/test-postgres). (Sockets need no entry: /run and /tmp are
 * private, PRIVATE_DIRS.)
 */
export function machineHidden() {
  return ["/srv/ai", "/srv/code/team", "/srv/code/test-postgres"];
}

/** The folders hidden from the agent: the owner's home (and this process's), the runtime folder of sockets, machineHidden(), extras. */
export function defaultHidden({ ownerHome = homedir(), extra = [] } = {}) {
  const list = [ownerHome, homedir(), process.env.XDG_RUNTIME_DIR, ...machineHidden(), ...extra];
  // A socket or folder reached through a link (/var/run is /run) is hidden at its real path.
  return [...new Set(list.filter((p) => typeof p === "string" && isAbsolute(p) && existsSync(p)).map((p) => real(resolve(p))))].filter((p) => p !== sep);
}

/**
 * What to hide of the shared work root, which holds every run's checkout (card W01c): the work root itself, so a run sees
 * only its own checkout (bound back writable by bwrapPrefix, after the work root's empty tmpfs). When a folder the agent
 * must still read (`keep`: the reference repositories, the bench, other read-only trees) is the work root or lies inside
 * it, hiding the whole of it would hide that too: then each other entry present now (the siblings' checkouts) is hidden
 * instead, leaving the run's own checkout and the entries holding a kept folder. Nothing without a work root.
 */
export function workRootHidden({ workRoot, ownDir, keep = [] }) {
  if (typeof workRoot !== "string" || !existsSync(workRoot)) return [];
  const wr = real(resolve(workRoot));
  if (wr === sep) return [];
  const kept = keep.filter((p) => typeof p === "string").map((p) => real(resolve(p))).filter((p) => under(p, wr));
  if (kept.length === 0) return [wr];
  const own = typeof ownDir === "string" ? real(resolve(ownDir)) : null;
  let names;
  try { names = readdirSync(wr); } catch { return []; }
  // Each entry by where it really is: a link in the work root to the run's own checkout or to a kept folder (the hidden
  // list is resolved again later) must not hide that; a link leading out of the work root is not a sibling's checkout.
  const entries = [...new Set(names.map((n) => real(join(wr, n))))].filter((p) => p !== wr && under(p, wr));
  return entries.filter((p) => !(own && (under(own, p) || under(p, own))) && !kept.some((k) => under(k, p)));
}

/** File names that hold keys and logins by convention (a `.env` but not its `.example`, key files, login files). */
const CREDENTIAL_FILE = /^(?:\.env(?:\.(?!(?:example|sample|template|dist)$)[\w.-]+)?|.+\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk)|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|\.netrc|_netrc|\.git-credentials|\.npmrc|\.pypirc|\.pgpass|\.htpasswd|credentials(?:\.json)?|.+\.credentials\.json|secrets?\.(?:json|ya?ml|toml|env)|.+-token|service-account.*\.json)$/i;
/** Folder names that hold keys and logins by convention. */
const CREDENTIAL_DIR = /^(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.secrets?|secrets?|credentials)$/i;
const SCAN_SKIP = new Set(["node_modules", ".git", "dist", ".cache", ".pnpm-store"]);

/** This process's supplementary groups (its own group left out): what a user namespace cannot drop. */
export const supplementaryGroups = () => (typeof process.getgroups === "function" ? process.getgroups().filter((g) => g !== process.getgid()) : []);

/**
 * Credential-like places inside the folders the agent can read (`roots`, the read-only trees): files named like keys or
 * logins (CREDENTIAL_FILE) and folders named so (CREDENTIAL_DIR) unless `byName` is false; folders of this user only it
 * may open (mode 0700: the owner marked them private); unix sockets (a service reachable from any network namespace);
 * and entries of another user that one of `groups` (the supplementary groups, which the sandbox keeps) may read or enter
 * and others may not. Down to `maxDepth` levels, not into node_modules, .git or dist, not into `exclude` (the run's own folders),
 * links not followed, at most `limit` paths (then `truncated`). The cost is a walk of the trees' upper levels at each
 * run's start (well under a second for /srv/code and SYSTEM_ROOTS here); what it finds is hidden like the listed folders.
 */
export function credentialPaths(roots, { exclude = [], maxDepth = 5, limit = 4000, byName = true, groups = supplementaryGroups(), uid = typeof process.getuid === "function" ? process.getuid() : -1 } = {}) {
  const found = [];
  let truncated = false;
  const ex = exclude.filter((p) => typeof p === "string").map((p) => real(p)).filter((p) => p !== sep);
  const gs = new Set(groups);
  // What a group grants beyond what everyone has (read or enter; writing is moot on a read-only file system, and a socket
  // is hidden anyway), for an entry this user does not own.
  const groupOnly = (st) => st.uid !== uid && gs.has(st.gid) && ((st.mode >> 3) & 5 & ~(st.mode & 5)) !== 0;
  const walk = (d, depth) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.length >= limit) { truncated = true; return; }
      const p = join(d, e.name);
      if (ex.some((x) => under(p, x))) continue;
      if (e.isSymbolicLink()) continue;
      if (e.isSocket()) { found.push(p); continue; }
      let st;
      try { st = statSync(p); } catch { continue; }
      if (groupOnly(st)) { found.push(p); continue; }
      if (e.isDirectory()) {
        if (((st.mode & 0o077) === 0 && st.uid === uid) || (byName && CREDENTIAL_DIR.test(e.name))) { found.push(p); continue; }
        if (!SCAN_SKIP.has(e.name) && depth < maxDepth) walk(p, depth + 1);
      } else if (byName && CREDENTIAL_FILE.test(e.name)) found.push(p);
    }
  };
  const top = [...new Set(roots.filter((r) => typeof r === "string" && existsSync(r)).map((r) => real(r)))];
  for (const r of top) if (!top.some((o) => o !== r && under(r, o))) walk(r, 1);
  return { paths: [...new Set(found)], truncated };
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
 * The bubblewrap command prefix. The whole file system read-only, a minimal /dev of its own, a process list and /proc of
 * its own, its own IPC, and its own network namespace (only a loopback device: no route to the host's loopback services,
 * the tailnet, the internet or the host's abstract unix sockets; the model is reached through the bridge, lib/net-bridge.mjs).
 * The user's supplementary groups (adm, docker, ...) are shown as nogroup inside but still count for file access (a user
 * namespace cannot drop them): what they open is hidden instead (/var/log private, credentialPaths). Then the private folders (PRIVATE_DIRS) get an
 * empty tmpfs each, each hidden folder an empty one (a hidden file /dev/null), shortest path first; read-only trees under
 * a private folder are bound back read-only (one that is or holds a private folder is left out: it would bring back the
 * host's /tmp), unless inside a hidden folder; then the run's own folders bound back writable and the programs it needs
 * bound back read-only where they lie under a hidden or private folder, and a hidden place inside one of those covered
 * again; then the bench's own settings read-only.
 */
export function bwrapPrefix({ bwrap = "bwrap", hidden, readOnlyTrees = [], writable = [], readable = [], readOnly = [], privateDirs = PRIVATE_DIRS }) {
  const argv = [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--unshare-ipc", "--unshare-net", "--proc", "/proc", "--die-with-parent"];
  const inAny = (p, list) => list.some((h) => under(resolve(p), h) || under(real(p), h));
  const isHidden = (p) => inAny(p, hidden);
  const isPrivate = (p) => inAny(p, privateDirs);
  const trees = [...new Set(readOnlyTrees.map((p) => real(p)))]
    .filter((p) => p !== sep && existsSync(p) && !isHidden(p) && isPrivate(p) && !privateDirs.some((d) => under(d, p)));
  // A hidden folder under a private one is already gone, unless a tree or a folder of the run's bound back around it would
  // show it again: then it is covered too.
  const shownAgain = (h) => [...trees, ...writable, ...readable].some((t) => under(h, resolve(t)) || under(h, real(t)));
  const covers = [...privateDirs.map((d) => [d, "private"]), ...hidden.filter((h) => !isPrivate(h) || shownAgain(h)).map((h) => [h, "hide"]), ...trees.map((t) => [t, "ro"])]
    .sort((a, b) => a[0].length - b[0].length);
  for (const [h, how] of covers) {
    if (how === "private") { argv.push("--tmpfs", h); continue; }
    if (how === "ro") { argv.push("--ro-bind", h, h); continue; }
    let isDir = true;
    try { isDir = statSync(h).isDirectory(); } catch { continue; }
    argv.push(...(isDir ? ["--tmpfs", h] : ["--ro-bind", "/dev/null", h]));
  }
  // Bound back at where each folder really is: bubblewrap cannot make a mount point through an absolute link whose target
  // lies under a covered folder (a work root given as a link, hidden by card W01c), and the link still leads there.
  const back = [...writable.map((p) => [p, "--bind"]), ...readable.filter((p) => isHidden(p) || isPrivate(p)).map((p) => [p, "--ro-bind"])]
    .filter(([p]) => existsSync(p)).map(([p, how]) => [real(p), how, resolve(p)])
    .sort((a, b) => a[0].length - b[0].length);
  for (const [p, how] of back) argv.push(how, p, p);
  // A hidden place inside a folder bound back (a later mount shows what was covered under it) is covered again.
  for (const h of hidden) {
    if (!back.some(([p]) => h !== resolve(p) && h !== real(p) && (under(h, resolve(p)) || under(h, real(p))))) continue;
    let isDir = true;
    try { isDir = statSync(h).isDirectory(); } catch { continue; }
    argv.push(...(isDir ? ["--tmpfs", h] : ["--ro-bind", "/dev/null", h]));
  }
  // A folder named through a link that itself lies in a covered place (a private or hidden folder that no tree or folder
  // bound back shows again, such as a work root given as a link directly in /tmp) is also bound at that spelling: the link
  // is not there inside, and the agent is given that spelling (its working folder, its log file). bubblewrap binds from the
  // host's side, so a hidden place inside that folder is covered again at that spelling as well.
  const covered = (q) => [...privateDirs, ...hidden].some((h) => under(q, h)) && ![...trees, ...back.map(([p]) => p)].some((t) => under(q, t));
  for (const [p, how, given] of [...back].sort((a, b) => a[2].length - b[2].length)) {
    if (given === p || !covered(given)) continue;
    argv.push(how, p, given);
    for (const h of hidden) {
      if (h === p || !under(h, p)) continue;
      let isDir = true;
      try { isDir = statSync(h).isDirectory(); } catch { continue; }
      const at = given + h.slice(p.length);
      argv.push(...(isDir ? ["--tmpfs", at] : ["--ro-bind", "/dev/null", at]));
    }
  }
  for (const p of readOnly) if (existsSync(p)) argv.push("--ro-bind", p, p);
  argv.push("--");
  return argv;
}

// ---- the per-run folder ----

/**
 * Makes one run's isolation: a temporary folder holding the agent's home, temp folder, git settings and git wrapper, and,
 * when the owner's Pi configuration has the run's provider, a per-run Pi configuration that reaches the model server
 * through the key proxy (with `netns`, through the bridge: `bridge` { socketPath, port } is what lib/net-bridge.mjs is
 * started with). Returns { base, home, env, allowRoots, readOnly, providerProxied, bridge, close() } (close stops the
 * proxy and removes the folder).
 */
export async function prepareIsolation({ checkoutDir, artifactsDir, ownerHome = homedir(), provider, model, realGit, piBin, sourceEnv = process.env, tmpRoot = tmpdir(), netns = false }) {
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
    // testRoots: the run's temporary folder (TMPDIR below), where a project's own tests make their repositories; a refusal
    // there of an askpass or proxy program alone is logged as the tests' own and not counted (git-guard.mjs, card W01d).
    writeFileSync(guardConfig, JSON.stringify({ realGit, allowRoots, testRoots: [real(join(base, "tmp"))], checkout: real(checkoutDir), gitConfig: gitconfig, log: join(artifactsDir, "git-guard.log") }));
    const node = process.execPath;
    if (IS_WIN) writeFileSync(join(base, "bin", "git.cmd"), `@"${node}" "${GIT_GUARD}" "${guardConfig}" %*\r\n`);
    else {
      writeFileSync(join(base, "bin", "git"), `#!/bin/sh\nexec "${node}" "${GIT_GUARD}" "${guardConfig}" "$@"\n`);
      chmodSync(join(base, "bin", "git"), 0o755);
    }
    let providerProxied = false, bridge = null;
    const entry = provider ? ownerProvider(ownerHome, provider) : null;
    if (entry) {
      // In a network namespace of its own (netns) the agent reaches the proxy through the bridge (lib/net-bridge.mjs), which
      // listens on loopback inside the namespace and forwards to the proxy's unix socket in the per-run folder.
      const socketPath = netns ? join(base, "model.sock") : null;
      if (socketPath && Buffer.byteLength(socketPath) > 100) throw new Error(`the temporary folder's path is too long for the model route's socket (${socketPath}); set TMPDIR to a shorter folder`);
      proxy = await startKeyProxy({ upstreamBaseUrl: entry.baseUrl, apiKey: entry.apiKey, socketPath });
      if (netns) bridge = { socketPath, port: 20_000 + randomInt(40_000) };
      const agentBase = netns ? `http://127.0.0.1:${bridge.port}${proxy.basePath}` : proxy.baseUrl;
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      const write = (name, obj) => { writeFileSync(join(agentDir, name), `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 }); chmodSync(join(agentDir, name), 0o600); };
      write("models.json", { providers: { [provider]: agentProviderEntry(entry, agentBase, proxy.token) } });
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
    return { base, home, env, allowRoots, readOnly, providerProxied, bridge, close };
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
// Options before the subcommand: `-C`, `-c` and the long options git also takes with a separate value (`--git-dir <path>`)
// eat that value (W01e second review: `git --git-dir /x/.git push` was not seen).
const GIT_OPTS = String.raw`(?:\s+(?:(?:-[Cc]|--(?:git-dir|work-tree|namespace|exec-path|config-env|super-prefix|list-cmds))\s+(?:"[^"]*"|'[^']*'|\S+)|--?[A-Za-z][\w-]*(?:=\S+)?))*`;
const PUSH = new RegExp(`${GIT}${GIT_OPTS}\\s+(?:push|send-pack|http-push)\\b`);
/** `git remote add|set-url ...` (the rest of the segment captured) and `git config remote.<name>.(push)url <value>`. */
const REMOTE = new RegExp(`${GIT}${GIT_OPTS}\\s+remote(?:\\s+-\\S+)*\\s+(?:add|set-url)\\b([^;&|\\n]*)`, "i");
const REMOTE_CONFIG = new RegExp(`${GIT}\\b[^;&|\\n]*\\bconfig\\b[^;&|\\n]*\\bremote\\.[^\\s.]+\\.(?:push)?url\\b([^;&|\\n]*)`, "i");
/** The owner's keys, logins and sockets wherever named. */
const CREDENTIALS = /(?:^|[^\w])\.ssh(?:[/\\"'\s]|$)|\.git-credentials\b|(?<![\w-])id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?\b|\.netrc\b|\bgh-token\b|\.config\/gh\b|SSH_AUTH_SOCK|openssh_agent|\bssh-add\b|\.pi[/\\]agent\b|docker\.sock\b|(?<![\w-])docker\s+(?:run|exec|create|cp)\b|\bteam[/\\]secrets\b|test-postgres[/\\]credentials\b|\.credentials\.json\b|\.codex[/\\]auth\b|\.docker[/\\]config\.json\b/;
/** The same under a home folder only: what a search of the code (grep, rg, git grep) counts, since code may name `.ssh`. */
const HOME_CREDENTIALS = /(?:~|\$HOME|\$\{HOME\}|\/home\/[^/\s"']+|\/root|\/Users\/[^/\s"']+)[/\\]\.(?:ssh|git-credentials|netrc|config[/\\]gh|pi[/\\]agent|aws|docker|kube|gnupg|codex|claude|paperclip|hermes)\b/;
const SEARCH_TOOLS = /^(?:grep|egrep|fgrep|rg|ag|ack)$/;

/** Whether a remote address given on a command line is not plainly a local folder (unknown, a variable, a network address). */
function nonLocalAddress(rest) {
  const all = splitAlias(rest), words = [];
  for (let i = 0; i < all.length; i++) { if (all[i] === "-t" || all[i] === "-m") { i++; continue; } if (!all[i].startsWith("-")) words.push(all[i]); }
  // `remote add <name> <url>`, `remote set-url <name> <url> [old]`, `config remote.x.url <url>` (the name already eaten).
  const url = words.length >= 2 ? words[1] : words[0];
  if (url === undefined || url === "" || url.includes("$") || url.includes("`")) return true;
  if (/^file:\/\//i.test(url)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) || /^[^/\\.~][^/\\]*:/.test(url);
}

/** The program a shell segment runs (after variable assignments and env/time/command/sudo/nice). */
function programOf(segment) {
  const words = splitAlias(segment.trim());
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || /^(?:env|time|command|sudo|nice|exec|xargs)$/.test(words[i]))) i++;
  const w = (words[i] ?? "").split("/").pop();
  return w === "git" && words[i + 1] === "grep" ? "grep" : w;
}

/** A shell command cut at `;`, `&`, `|` and newlines outside quotes (a search pattern `'a|b'` stays whole). */
function shellSegments(c) {
  const out = [];
  let cur = "", quote = null;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (quote) { if (ch === quote) quote = null; else if (ch === "\\" && quote === '"' && i + 1 < c.length) { cur += ch + c[++i]; continue; } cur += ch; continue; }
    if (ch === "\\" && i + 1 < c.length) { cur += ch + c[++i]; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * A second reading of a command for a push or a remote (W01e second review): line continuations joined, quotes dropped,
 * and an argv list's punctuation (`,` `[` `]` `(` `)`) read as spaces, so `git \<newline> push`, `"git" push`, `git'' push`,
 * Python's `subprocess.run(["git", "push"])` and Node's `execFileSync("git", ["push"])` read as `git push`. It only adds
 * kinds. The key search does not use it: without its quotes a search pattern `'a|\.ssh'` would split into programs.
 */
const looseReading = (c) => c.replace(/\\\r?\n/g, " ").replace(/["'`]/g, "").replace(/[,[\]()]/g, " ");

/** A push or a remote in one command text. */
function gitKinds(c, found, cut) {
  if (PUSH.test(c)) found.add("push");
  // In a text cut at a size limit, a remote command that runs to the cut has an address that is not known.
  const toCut = (m) => cut && m.index + m[0].length === c.length;
  const r = REMOTE.exec(c);
  if (r && (nonLocalAddress(r[1] ?? "") || toCut(r))) found.add("remote");
  const rc = REMOTE_CONFIG.exec(c);
  if (rc && (nonLocalAddress(`x ${rc[1] ?? ""}`) || toCut(rc))) found.add("remote");
}

/** The kinds seen in one shell command. */
function commandKinds(c, found, cut = false) {
  gitKinds(c, found, cut);
  const loose = looseReading(c);
  if (loose !== c) gitKinds(loose, found, cut);
  for (const segment of shellSegments(c)) {
    let prog = "";
    try { prog = programOf(segment); } catch { /* unbalanced quotes: searched in full */ }
    if ((SEARCH_TOOLS.test(prog) ? HOME_CREDENTIALS : CREDENTIALS).test(segment)) found.add("credentials");
  }
}

/**
 * What the agent's tool calls show it tried: `push` (a git push), `remote` (adding or changing a remote to an address that
 * is not a local folder), `credentials` (a path or socket of the owner's keys and logins: ~/.ssh, .git-credentials, id_*,
 * .netrc, the gh token, SSH_AUTH_SOCK, Pi's own configuration, the container engine, the team's key folder; a search of
 * the code with grep, rg or git grep counts only a path under a home folder, since code may name `.ssh`). Returns the
 * kinds seen, sorted. Detection only: a command assembled at run time is not seen.
 *   commands: one entry per call, either summary.toolTexts (read from the full parsed arguments) or an argument JSON
 *   string (summary.toolCommands, older records). See lib/tool-args.mjs: only a shell tool's `command`/`cmd`/`script`
 *   and the like are read as commands, a file tool's fields as paths, and file content and edit text not at all.
 *   A text cut at a size limit is read as far as it is visible and up to its last whole word (`git pu|` is not a push,
 *   `git push|` is).
 */
export function credentialAttempts(commands) {
  const found = new Set();
  for (const entry of commands) {
    const t = toolCallTexts(entry);
    // A cut text is read both as far as it is visible and up to its last whole word: each reading can see what the other
    // misses (`git push|` or `$SSH_AUTH_SOCK|` at the cut); a remote command that runs to the cut has an unknown address.
    for (const c of t.commands) { commandKinds(c.text, found, c.cut); if (c.cut) commandKinds(wholePart(c), found); }
    for (const p of t.paths) if (CREDENTIALS.test(p.text) || (p.cut && CREDENTIALS.test(wholePart(p)))) found.add("credentials");
    // A file tool's search pattern is a search of the code, read as a grep in bash is: only a key path under a home folder.
    for (const p of t.patterns ?? []) if (HOME_CREDENTIALS.test(p.text) || (p.cut && HOME_CREDENTIALS.test(wholePart(p)))) found.add("credentials");
  }
  return [...found].sort();
}
