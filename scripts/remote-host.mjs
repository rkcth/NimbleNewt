// The remote worker host (card L05e): what runs on another machine and takes work from a NimbleNewt controller over the worker protocol.
// It is the composition of the pieces the earlier cards built and tested one by one: the protocol client and poller (H02, H07), the offer runner (L05d), the sandbox launcher and the worker process running Pi (H12k), the machine's own model
// relay whose stream tap is the runner's (L05c, L05d), the tool bridge through the protocol route (L05e) and the workspace host with its security hook (H12m, U11d).
// Like `local-host.mjs`, it lives here because the packages do not import each other.
//
// What it never does: load, unload or switch a model (its routes are the endpoints in its own configuration; a provider key is read from the environment variable the configuration NAMES, at each model call), print or keep a secret (the
// host credential and a provider key are never logged, and a failure is described without them), or run anything outside the sandbox. A machine that cannot confine agents gets no host and the reason in plain words.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SYSTEM_ROOTS = new Set(["/usr", "/bin", "/lib", "/sbin", "/lib64", "/"]);
const FALLBACK_WINDOW = 32_768;
/** The controller's attempt IDs; an offer naming anything else (a path, `..`) is not run, since its ID becomes a folder of this host. */
const ATTEMPT = /^att-[a-z2-7]{20}$/;

/** What the machine's own sandbox enforces, found by trying (not claimed): `full` only where the launcher's plan really limits it. */
async function abilitiesOf(worker) {
  const caps = await worker.detectLimitCapabilities();
  const probe = worker.limitedPlan({ file: "/bin/true", args: [], env: {} }, { cpus: 1, memoryMb: 1024, diskMb: 1024, processes: 100 }, caps);
  const enforces = Object.fromEntries(probe.report.map((r) => [r.limit, r.enforced]));
  // The wall-clock time is the host launcher's own limit, which a launch always applies.
  enforces.wallTimeMs = "full";
  return { formats: [1], features: ["limits", "wall-time"], enforces };
}

/** The checks on a configuration; each problem is said in plain words and names the field, never a value that could be a secret. */
export function checkRemoteConfig(config) {
  const problems = [];
  if (config === null || typeof config !== "object") return ["the configuration must be an object"];
  let url;
  try { url = new URL(config.url); } catch { problems.push("url: must be the controller's worker address, such as https://controller.example:8443"); }
  if (url !== undefined && url.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) problems.push("url: a worker's credential must not cross a network in the clear; use https");
  if (typeof config.token !== "string" || config.token.length < 8) problems.push("token: the host credential is missing (give it by the NIMBLENEWT_WORKER_TOKEN environment variable or a tokenFile)");
  if (typeof config.base !== "string" || !isAbsolute(config.base)) problems.push("base: must be an absolute folder this host owns");
  if (typeof config.root !== "string" || !isAbsolute(config.root)) problems.push("root: must be the absolute path of the built NimbleNewt checkout");
  if (config.routes === null || typeof config.routes !== "object" || Object.keys(config.routes).length === 0) problems.push("routes: name at least one model route and its endpoint");
  else for (const [route, entry] of Object.entries(config.routes)) {
    if (!/^[^/\s]+\/[^\s]+$/.test(route)) problems.push(`routes.${route.slice(0, 40)}: a route is provider/model`);
    if (entry === null || typeof entry !== "object" || typeof entry.url !== "string") problems.push(`routes.${route.slice(0, 40)}.url: must be the endpoint's address`);
    else if (entry.keyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(String(entry.keyEnv))) problems.push(`routes.${route.slice(0, 40)}.keyEnv: must be the NAME of an environment variable`);
  }
  if (config.landing !== undefined) {
    if (config.landing === null || typeof config.landing !== "object" || Array.isArray(config.landing)) problems.push("landing: must map project IDs to the branch their work is landed on");
    else for (const [projectId, branch] of Object.entries(config.landing)) {
      if (typeof branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) || branch.includes("..")) problems.push(`landing.${projectId.slice(0, 40)}: must be a branch name`);
      else if (config.projects === null || typeof config.projects !== "object" || !Object.hasOwn(config.projects, projectId)) problems.push(`landing.${projectId.slice(0, 40)}: names a project with no shared repository in projects`);
    }
  }
  return problems;
}

/**
 * Starts the host. `setup.root` is the NimbleNewt checkout (built); `setup.load` gives a built package (default: its dist/index.js). `config`:
 *   url, token, ca?          the controller's worker address, this host's credential, the certificate authority to trust
 *   hostId?, workerVersion?  names this host reports (default `remote`, `remote-host`)
 *   base                     the folder this host owns for checkouts, attempt homes and scratch (never inside the controller's data)
 *   protectedPaths?          folders on this machine that no sandbox mount may reach (its credential files)
 *   projects?                { projectId: absolute folder of the shared repository } for projects whose checkout lives on this machine
 *   landing?                 { projectId: branch } the branch finished work of a project is landed on here (with the commit permit required); a project not named is never landed on this host
 *   routes                   { "provider/model": { url, keyEnv?, contextTokens?, maxTokens? } }
 *   poller?                  { waitMs, heartbeatMs, spreadMs, minGapMs, baseBackoffMs, maxBackoffMs } to change how often the host asks (defaults are the poller's)
 *   log?                     (line) => void; told one plain line per notable event (no secret)
 * Returns { stop, runner, client, finished } (`finished` ends when the poller has stopped).
 */
export async function startRemoteWorker(setup, config) {
  const problems = checkRemoteConfig({ root: setup.root, ...config });
  if (problems.length > 0) throw new Error(`the remote worker host is not configured: ${problems.join("; ")}`);
  const log = (line) => { try { config.log?.(line); } catch { /* a log failure never stops the host */ } };
  const load = setup.load ?? ((pkg) => import(pathToFileURL(join(setup.root, "packages", pkg, "dist", "index.js")).href));
  if (process.platform !== "linux") throw new Error("the remote worker host runs agents in bubblewrap, which is Linux only so far (the macOS and Windows sandboxes are separate cards)");
  const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
  if (SYSTEM_ROOTS.has(nodeRoot)) throw new Error(`Node.js is installed in ${nodeRoot}, a system directory, and mounting it would show the sandbox the whole system; use a Node.js installed in a folder of its own`);
  const [controller, worker, piAdapter] = await Promise.all([load("controller"), load("worker"), load("pi-adapter")]);
  const base = resolve(config.base);
  for (const dir of [base, join(base, "work"), join(base, "attempts"), join(base, "git")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hostId = config.hostId ?? "remote";
  // Folders no sandbox mount may reach (this machine's credential files and the like); the host's own folders are laid out so the agent sees only its checkout.
  const protectedPaths = (config.protectedPaths ?? []).map((p) => resolve(p));

  const launcher = await worker.SandboxLauncher.create({ protectedPaths, audit: () => undefined });
  if (!launcher.capacity.available || launcher.capacity.backend !== "bubblewrap") {
    await launcher.stop().catch(() => undefined);
    throw new Error(`the sandbox is not usable here (${launcher.capacity.reason ?? "no bubblewrap"}); install bubblewrap and allow unprivileged user namespaces`);
  }
  const git = await worker.GitBridge.create({ scratch: join(base, "git") }).catch(async (error) => { await launcher.stop().catch(() => undefined); throw error; });
  const abilities = await abilitiesOf(worker);

  const client = new controller.RemoteWorkerClient({ url: config.url, token: config.token, workerVersion: config.workerVersion ?? "remote-host", ...(config.ca === undefined ? {} : { ca: config.ca }) });
  // A security sign from the workspace host goes to the controller over the host channel (card U11d); it carries a kind, a key and a project ID, never a path or a secret. A failure to send it is logged and never stops the work.
  const security = (event) => { void client.reportSecurity(event).catch((error) => log(`a security report could not be sent (${describe(error)})`)); };
  const shared = new Map(Object.entries(config.projects ?? {}).filter(([, folder]) => isFolder(folder)));
  let local;
  // The landing policy (card H12t): the branch named for the project in this host's configuration (`landing`), with the commit permit required and the default protected paths kept. A project with no branch named
  // here is not landed on this host (refused, never guessed). The owner's chat settings live in the controller and do not reach a remote host yet (the request does not carry them).
  const landingBranches = new Map(Object.entries(config.landing ?? {}).filter(([projectId, branch]) => shared.has(projectId) && typeof branch === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) && !branch.includes("..")));
  const workspaces = new worker.LocalWorkspaces({ root: join(base, "work"), git, shared: (projectId) => shared.get(projectId), busy: () => local?.busyAttempts() ?? [], landing: ({ projectId }) => (landingBranches.has(projectId) ? { branch: landingBranches.get(projectId), requirePermit: true, protectDefaults: true } : undefined), security });
  const relay = new controller.ModelRelay({ ...(config.fetch === undefined ? {} : { fetch: config.fetch }), endpoint: (route) => endpointOf(config, route) });
  let runner;
  const attempts = new Map();

  const parts = worker.localWorkerParts({
    launcher, app: worker.appFromRepository(setup.root, { root: nodeRoot, executable: "bin/node" }), protectedPaths,
    workspace: async (order) => {
      if (!ATTEMPT.test(String(order.attemptId))) throw new Error("the attempt ID of the order is not an attempt ID; nothing is made for it");
      const made = await workspaces.ensure({ taskId: order.taskId, projectId: order.projectId });
      const home = join(base, "attempts", order.attemptId, "home");
      const scratch = join(base, "attempts", order.attemptId, "scratch");
      mkdirSync(home, { recursive: true, mode: 0o700 }); mkdirSync(scratch, { recursive: true, mode: 0o700 });
      return { checkout: made.checkout, gitDir: made.gitDir, home, scratch };
    },
    model: (order) => {
      const route = String(order.route);
      const slash = route.indexOf("/");
      const entry = Object.hasOwn(config.routes, route) ? config.routes[route] : undefined;
      return { alias: "m0", provider: route.slice(0, slash), api: "openai-completions", modelId: route.slice(slash + 1), contextWindow: entry?.contextTokens ?? FALLBACK_WINDOW, maxTokens: entry?.maxTokens ?? 4096, reasoning: false, input: ["text"] };
    },
    // The agent's own tool namespace: a stable digest of the agent, so the same agent has the same names on every host.
    namespaceId: (order) => createHash("sha256").update(String(order.agentId)).digest("hex").slice(0, 16),
    // The process's tool requests go to the controller's own bridge through the protocol route (card L05e): the credential the process holds is forwarded in the body of that one request and never kept.
    bridge: (order, _call, token, request) => runner.bridge(order.attemptId, token, request),
    // The model's thinking the process reports goes to the controller's thinking store through the protocol route (card U09c): untrusted text, sent as it came; a controller without the route, or a failure, drops it and never changes the turn.
    onThinking: (order, blocks) => runner.thinking(order.attemptId, blocks),
    // Every model call of the process is recorded by the controller as a generation of the task through the runner's tap, and its progress reaches stall detection from the stream messages.
    relay: (order, request) => {
      const route = String(order.route);
      return relay.forAttempt({ route, model: route.slice(route.indexOf("/") + 1), stream: runner.tap(order.attemptId) }).relay(request).catch((error) => { log(`attempt ${order.attemptId}: the model call was refused or failed (${describe(error)})`); throw error; });
    },
    // The recipe's limits (the owner's, from the dispatch contract) are applied at launch; a limit the sandbox cannot enforce in full refuses the launch unless the contract allowed best effort.
    requireEnforced: true,
  });
  local = new controller.LocalWorker({
    hostId: `host:${hostId}`, resources: { cpus: Math.max(1, cpus().length), memoryMb: Math.max(256, Math.floor(totalmem() / 1048576)) }, version: config.workerVersion ?? "remote-host",
    schedule: (beat) => { const timer = setInterval(() => { void beat(); }, 1000); timer.unref?.(); return () => clearInterval(timer); },
    sandbox: parts.sandbox, runtimes: { open: (order, call, from) => parts.runtimes.open(order, call, from) },
    progress: (scope) => workspaces.progress(scope),
    capabilities: () => capabilitiesOf(piAdapter),
  });
  runner = new controller.RemoteOfferRunner({ client, host: local, abilities, onTrouble: (attemptId, what, error) => log(`attempt ${attemptId}: ${what} did not go through (${describe(error)})`) });
  const responder = new controller.WorkspaceResponder({ client, port: workspaces.port, busy: () => local.busyAttempts(), onError: (error) => log(`a workspace answer could not be sent (${describe(error)})`) });

  const abort = new AbortController();
  const poller = new controller.HostPoller({
    client, capabilities: capabilitiesOf(piAdapter),
    ...pollerSettings(config.poller),
    // One offer at a time per attempt: a repeat of an offer already being run is the controller offering again, not a second run.
    onOffers: async (offers) => {
      for (const offer of offers) {
        // The ID names folders of this host and is sent back in addresses: an offer whose ID is not an attempt ID (a confused or hostile controller) is not run.
        if (!ATTEMPT.test(String(offer?.order?.attemptId))) { log("an offer whose attempt ID is not an attempt ID was not run"); continue; }
        if (attempts.has(offer.order.attemptId)) continue;
        attempts.set(offer.order.attemptId, offer.placement);
        void runner.run(offer).then((outcome) => log(`attempt ${offer.order.attemptId} ${outcome}`), (error) => log(`attempt ${offer.order.attemptId} broke (${describe(error)})`)).finally(() => attempts.delete(offer.order.attemptId));
      }
    },
    onWorkspace: (requests, withdrawn) => responder.handle(requests, withdrawn),
    // After a reconnect the controller is told what this host still holds and answers for each (card H09b).
    held: () => [...attempts].map(([attemptId, placement]) => ({ attemptId, placement })),
    onReconciled: async (answer) => { for (const v of answer.verdicts) await runner.verdict(v.attemptId, v.verdict); },
    onTrouble: (event) => log(`${event.kind}: ${describe(event.error)}; trying again in ${Math.round(event.retryInMs / 1000)} s`),
  });
  const finished = poller.run(abort.signal);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    abort.abort();
    await finished.catch(() => undefined);
    await launcher.stop().catch(() => undefined);
  };
  return { stop, runner, client, finished };
}

/** The poller's own timings from the configuration (waitMs, heartbeatMs, spreadMs, minGapMs, baseBackoffMs, maxBackoffMs); a figure that is not a whole number of milliseconds is left out and the poller's default stands. */
function pollerSettings(settings) {
  if (settings === null || typeof settings !== "object") return {};
  return Object.fromEntries(["waitMs", "heartbeatMs", "spreadMs", "minGapMs", "baseBackoffMs", "maxBackoffMs"].filter((k) => Number.isSafeInteger(settings[k]) && settings[k] >= 0).map((k) => [k, settings[k]]));
}

function capabilitiesOf(piAdapter) {
  return { os: "linux", arch: process.arch === "arm64" ? "arm64" : "x64", harnesses: [{ name: "pi", version: piAdapter.PINNED_PI_DURABLE_VERSION }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
}

/** The endpoint of a route from the configuration; the provider key is read from the environment variable the configuration names, at each call, and is in no log. */
function endpointOf(config, route) {
  if (!Object.hasOwn(config.routes, route)) return undefined;
  const entry = config.routes[route];
  return { url: entry.url, ...(entry.kind === undefined ? {} : { kind: entry.kind }), headers: () => {
    if (entry.keyEnv === undefined) return {};
    const key = process.env[entry.keyEnv];
    if (key === undefined || key === "") throw new Error(`the provider key for ${route} is not set (the environment variable ${entry.keyEnv})`);
    return { authorization: `Bearer ${key}` };
  } };
}

/** A failure described without anything that could be a credential: its kind and code, and a short message with the host credential and any `Bearer` text cut out. */
function describe(error) {
  const code = typeof error?.code === "string" ? `${error.code}: ` : "";
  return `${code}${String(error?.message ?? error).replace(/Bearer\s+\S+/gi, "Bearer [removed]").slice(0, 200)}`;
}

function isFolder(path) { try { return isAbsolute(path) && statSync(path).isDirectory(); } catch { return false; } }

/** The host credential from its own file: a regular file that only its owner can read or write (as ssh asks of a key), or the host does not start. */
function readTokenFile(path) {
  const st = statSync(path);
  if (!st.isFile()) throw new Error("tokenFile: must be a regular file");
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new Error("tokenFile: other users can read or change it; make it readable by its owner only (chmod 600)");
  return readFileSync(path, "utf8").trim();
}

/** Reads a configuration file; the host credential comes from `NIMBLENEWT_WORKER_TOKEN` or the `tokenFile` the file names (never from the file's own text, so a copied configuration holds no secret). */
export function readRemoteConfig(file, env = process.env) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (config.token !== undefined) throw new Error("token: the host credential must not be written in the configuration; use NIMBLENEWT_WORKER_TOKEN or tokenFile");
  const token = env["NIMBLENEWT_WORKER_TOKEN"] ?? (config.tokenFile === undefined ? undefined : readTokenFile(String(config.tokenFile)));
  const ca = config.caFile === undefined ? config.ca : readFileSync(config.caFile, "utf8");
  const { tokenFile: _t, caFile: _c, ...rest } = config;
  return { ...rest, ...(token === undefined ? {} : { token }), ...(ca === undefined ? {} : { ca }) };
}
