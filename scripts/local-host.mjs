// The worker host on this computer (card U14b): what the launcher builds when the owner turned `host.local.set` on.
// It is the composition the integration test of card H12k shows (the sandbox launcher, the worker process running Pi, the controller's model relay, the owner's limits and the tool bridge), made from the built packages.
// It lives here, with the other host code, because the packages do not import each other (the controller does not import the worker; the integration package holds tests only).
//
// What it never does: load, unload or switch a model (its routes are the providers the owner configured and their addresses are read from the owner's records at each call, the key from the secret store by its NAME at each call),
// print or keep a secret, or run anything outside the sandbox. A machine that cannot confine agents (no bubblewrap, no Node.js install of its own to mount) gets no host and the reason in plain words.
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { safeMessage } from "./safe-error.mjs";

/** The host's principal on this computer: `host:local`. */
export const LOCAL_HOST_NAME = "local";
export const LOCAL_HOST_ID = `host:${LOCAL_HOST_NAME}`;
/** How often the host says it is alive (the controller treats a host quiet for 90 seconds as stale). */
export const BEAT_MS = 20_000;
const SYSTEM_ROOTS = new Set(["/usr", "/bin", "/lib", "/sbin", "/lib64", "/"]);
/** What one agent's attempt asks the host for when it is placed (the host's capacity, declared below, says how many fit). */
export const ATTEMPT_RESOURCES = { cpus: 1, memoryMb: 2048 };
/** The context window assumed for a route the routing table gives none. */
const FALLBACK_WINDOW = 32_768;

/**
 * Whether the worker host may change agents' environments (the A09 runtime). OFF unless asked: a command-line switch (`--local-host-environments`) or `NIMBLENEWT_LOCAL_HOST_ENVIRONMENTS=1`.
 * Accepts 1/true/on and 0/false/off (or unset/empty); anything else is refused so a typo cannot silently leave it off or on.
 */
export function environmentsRequested(flag, envValue) {
  if (flag === true) return true;
  const read = (value, what) => {
    const v = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (v === "" || v === "0" || v === "false" || v === "off") return false;
    if (v === "1" || v === "true" || v === "on") return true;
    throw new Error(`${what} must be 1, true, on, 0, false or off`);
  };
  // `--local-host-environments=VALUE` (a parser that keeps the text after `=`) is read like the variable and wins over it: before, any such value silently left the switch off.
  if (typeof flag === "string") return read(flag === "" ? "-" : flag, "--local-host-environments=VALUE");
  return read(envValue, "NIMBLENEWT_LOCAL_HOST_ENVIRONMENTS");
}

/** The folder beside the data directory where the host keeps checkouts, attempt homes and script runs (the data directory itself is a protected path no sandbox mount may reach). */
export const hostBaseOf = (dataDir) => join(dirname(resolve(dataDir)), `${basename(resolve(dataDir))}.host`);

/**
 * @param {{ root: string, load?: (pkg: string) => Promise<any> }} setup `root` is the NimbleNewt checkout (built); `load` gives a built package (default: its dist/index.js).
 * @returns {(context: any) => Promise<any>} a `LocalHostBuilder` for `launch({ localHost })`.
 */
export function localHostBuilder(setup) {
  const load = setup.load ?? ((pkg) => import(pathToFileURL(join(setup.root, "packages", pkg, "dist", "index.js")).href));
  return async function build(ctx) {
    if (process.platform !== "linux") return { problem: "the worker host runs agents in bubblewrap, which is Linux only so far (the macOS and Windows sandboxes are separate cards); tasks wait for a host" };
    let nodeRoot;
    try { nodeRoot = dirname(dirname(realpathSync(process.execPath))); } catch { return { problem: "this Node.js install could not be found" }; }
    if (SYSTEM_ROOTS.has(nodeRoot)) return { problem: `Node.js is installed in ${nodeRoot}, a system directory, and mounting it would show the sandbox the whole system; use a Node.js installed in a folder of its own (a version manager or a download)` };
    const [controller, worker, piAdapter] = await Promise.all([load("controller"), load("worker"), load("pi-adapter")]);
    const dataDir = resolve(ctx.dataDir);
    const base = hostBaseOf(dataDir);
    for (const dir of [base, join(base, "work"), join(base, "attempts"), join(base, "git")]) mkdirSync(dir, { recursive: true, mode: 0o700 });

    const launcher = await worker.SandboxLauncher.create({ protectedPaths: [dataDir], audit: () => undefined });
    if (!launcher.capacity.available || launcher.capacity.backend !== "bubblewrap") {
      await launcher.stop().catch(() => undefined);
      return { problem: `the sandbox is not usable here (${launcher.capacity.reason ?? "no bubblewrap"}); install bubblewrap (the bwrap program) and allow unprivileged user namespaces` };
    }
    let scripts;
    try { scripts = await worker.hostScriptRunner({ launcher, base: worker.hostScriptBase(dataDir), protectedPaths: [dataDir], requireEnforced: true }); } catch (error) {
      await launcher.stop().catch(() => undefined);
      return { problem: `the tool runner could not be made: ${safeMessage(error, 200)}` };
    }
    // The runner's own word on whether any tool can run here (no sandbox, no interpreter to offer): said before the host claims it can run agents' tools (card T02d follow-up).
    const toolProblem = scripts.problem();
    if (toolProblem !== undefined) {
      await scripts.stop().catch(() => undefined);
      await launcher.stop().catch(() => undefined);
      return { problem: `no tool could run on this host (${String(toolProblem).slice(0, 200)})` };
    }
    // Changing an agent's environment (card A09 follow-up) is off unless the setup asks for it: the local host has no worker process to restore between attempts (each attempt starts its own), so the session probe below can only
    // confirm that nothing of the agent's session was touched, not read it back. With it on, approved package requests are installed into <data>.environments by the worker package's runtime; without it approved changes wait, as before.
    let environments;
    if (setup.environments === true) {
      environments = worker.localEnvironmentHost({
        root: worker.hostEnvironmentsBase(dataDir), protectedPaths: [dataDir],
        // An offline mirror: the request's https source is looked up under <environments>/mirror/<host>/<path>. No network.
        source: worker.directoryArtifactSource(join(worker.hostEnvironmentsBase(dataDir), "mirror")),
        // Each attempt starts its own worker from the active link; nothing to restart. The session lives in the controller's records, which an environment change never writes.
        worker: { session: async () => ({ sessionIntact: true, compactionIntact: true }) },
        scripts: worker.sandboxInstallScripts({ launcher, interpreter: { root: nodeRoot, executable: "bin/node" }, base: join(worker.hostEnvironmentsBase(dataDir), "install-runs") }),
      });
      if (environments.problem !== undefined) { ctx.print(`Agents' environments cannot be changed here: ${environments.problem}`); environments = undefined; }
      else { mkdirSync(join(environments.runtime.root, "mirror"), { recursive: true, mode: 0o700 }); mkdirSync(join(environments.runtime.root, "install-runs"), { recursive: true, mode: 0o700 }); await environments.runtime.recover(); }
    }
    let git;
    try { git = await worker.GitBridge.create({ scratch: join(base, "git") }); } catch (error) {
      await scripts.stop().catch(() => undefined);
      await launcher.stop().catch(() => undefined);
      return { problem: `the git bridge could not be made: ${safeMessage(error, 200)}` };
    }

    // The shared repository of a project is the folder of its first repository that is a local folder (the project's records say where). Read when an attempt's workspace is made and before each workspace request.
    const shared = new Map();
    const refreshShared = async () => {
      const projects = ctx.controller().services.projects;
      for (const item of await projects.listProjects({ limit: 200 })) {
        const folder = (item.repositories ?? []).map((r) => r.location).find((l) => typeof l === "string" && isAbsolute(l) && isFolder(l));
        if (folder === undefined) shared.delete(item.id); else shared.set(item.id, folder);
      }
    };
    let local;
    // The controller's parts the workspace port needs (card H12t), given when the controller builds the host (`build(services)` below): until then a landing has no policy and is refused, and nothing is reported.
    let composed;
    const workspaces = new worker.LocalWorkspaces({
      root: join(base, "work"), git, shared: (projectId) => shared.get(projectId),
      // The attempts with a call or model call in flight on this host (before the host is built none can run here). A request is never carried out under one; a busy check that throws refuses it.
      busy: () => (local === undefined ? [] : local.busyAttempts()),
      // The owner's landing policy for the task (card H12s), read fresh at each landing: the project's own landing branch (`project.branches.set`), else `workspace.landing.branch`; the permit is required unless the owner said
      // otherwise. A policy that cannot be read is no policy: the landing is refused.
      landing: (call) => (composed === undefined ? undefined : composed.landingPolicy(call)),
      // The worker-side security hook (card U11d), reported to the owner's Urgent watch.
      security: (event) => { composed?.reportSecurity(event); },
    });
    let heartbeat;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      await scripts.stop().catch(() => undefined);
      await launcher.stop().catch(() => undefined);
    };

    const relay = new controller.ModelRelay({ ...(ctx.fetch === undefined ? {} : { fetch: ctx.fetch }), endpoint: (route) => ctx.endpoint(route) });
    const cpuCount = Math.max(1, cpus().length);
    const memoryMb = Math.max(256, Math.floor(totalmem() / (1024 * 1024)));
    const tools = { runner: scripts.runner, facts: scripts.facts, isLocalHost: (hostId) => hostId === LOCAL_HOST_ID };

    const start = {
      harnesses: [piAdapter.PI_DECLARATION],
      tools,
      ...(environments?.runtime === undefined ? {} : { maintenance: { environmentRuntime: environments.runtime } }),
      dispatch: {
        local: {
          // The routing table's context size for the route is used (the host states none of its own).
          window: () => undefined,
          close,
          build: (services) => {
            composed = services;
            const parts = worker.localWorkerParts({
              launcher, app: worker.appFromRepository(setup.root, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [dataDir],
              workspace: async (order) => {
                await refreshShared();
                const made = await workspaces.ensure({ taskId: order.taskId, projectId: order.projectId, ...(typeof order.attemptId === "string" ? { attemptId: order.attemptId } : {}) });
                const home = join(base, "attempts", order.attemptId, "home");
                const scratch = join(base, "attempts", order.attemptId, "scratch");
                mkdirSync(home, { recursive: true, mode: 0o700 }); mkdirSync(scratch, { recursive: true, mode: 0o700 });
                return { checkout: made.checkout, gitDir: made.gitDir, home, scratch };
              },
              model: async (order) => {
                const route = String(order.route);
                const slash = route.indexOf("/");
                const entry = (await ctx.controller().services.routing.get())?.routes?.[route];
                return { alias: "m0", provider: route.slice(0, slash), api: "openai-completions", modelId: route.slice(slash + 1), contextWindow: entry?.contextTokens ?? FALLBACK_WINDOW, maxTokens: entry?.maxTokens ?? 4096, reasoning: false, input: ["text"] };
              },
              namespaceId: (order) => services.namespaceId(order),
              bridge: (order, call, token, request) => {
                if (services.bridge === undefined) throw new Error("the tool bridge is not available");
                return services.bridge(order, call, token, request);
              },
              relay: async (order, request) => {
                const route = String(order.route);
                return services.attemptRelay(order, relay, { model: route.slice(route.indexOf("/") + 1) }).relay(request);
              },
              context: (order) => services.context(order),
              ...(environments === undefined ? {} : { reach: (name, order) => environments.reach(name, order) }),
              heldForReview: (order) => ctx.controller().dispatch.dispatcher.heldForReview(order.attemptId),
              ...worker.ownerPolicyOptions(services),
            });
            const verifyDone = worker.doneVerifier({ workspaces, checks: parts.checks });
            local = new controller.LocalWorker({
              hostId: LOCAL_HOST_ID, resources: ATTEMPT_RESOURCES, version: "launcher", guards: services.guards, ownerPolicy: parts.ownerPolicy,
              schedule: (beat) => { const timer = setInterval(() => { void beat(); }, 1000); timer.unref?.(); return () => clearInterval(timer); },
              sandbox: parts.sandbox, runtimes: { open: (order, call, from) => parts.runtimes.open(order, call, from) },
              workspace: { run: async (call) => { await refreshShared(); return workspaces.port.run(call); } },
              progress: (scope) => workspaces.progress(scope),
              // The check of a done (card W05): the state of the checkout this port made, and the contract's checks run in the attempt's sandbox. Without it a done of a task whose contract names evidence or checks is never verified.
              verify: async (attemptId, scope, request) => { await refreshShared(); return verifyDone(attemptId, scope, request); },
              capabilities: () => ({ os: "linux", arch: process.arch === "arm64" ? "arm64" : "x64", harnesses: [{ name: "pi", version: piAdapter.PINNED_PI_DURABLE_VERSION }], isolation: ["bubblewrap"], tools: [], workspaces: [] }),
            });
            return local;
          },
        },
      },
    };

    /** With the controller up and the owner known: enroll the host, give it a credential held in this process only, announce it, declare its capacity once, and keep it beating. */
    const attach = async (running, owner) => {
      const issued = await running.services.principals.issueCredentialOnce(owner, { commandId: `local-host-${randomUUID()}`, principalId: LOCAL_HOST_ID, enrollHost: true });
      const self = await running.services.principals.authenticate(issued.token);
      const hosts = controller.HostService.withEpoch(running.storage, running.epoch, running.services.assignments);
      await local.register(hosts, self);
      const notes = [];
      const admission = controller.AdmissionService.withEpoch(running.storage, running.epoch);
      if (!Object.hasOwn((await admission.snapshot()).capacity, LOCAL_HOST_ID)) {
        const capacity = { cpus: Math.max(1, Math.floor(cpuCount / 2)), memoryMb: Math.max(256, Math.floor(memoryMb / 2)) };
        await admission.setCapacity({ commandId: "launcher-local-host-capacity", actor: owner.id, host: LOCAL_HOST_ID, capacity });
        notes.push(`The worker host on this computer may use ${capacity.cpus} of ${cpuCount} CPUs and ${capacity.memoryMb} of ${memoryMb} MB of memory (half of each; change it with the capacity limits).`);
      }
      // A task is matched to a model through the difficulty profiles; with none, every attempt is blocked at the route check. When the owner has set none, one profile is made that sends every difficulty to the `default` routing profile the
      // provider setup wrote (free and local routes first, then paid); the owner changes it any time with the difficulty operations.
      try {
        const difficulty = controller.DifficultyService.withEpoch(running.storage, running.epoch, running.services.routing, running.services.contracts);
        if ((await difficulty.profiles(owner)) === undefined) {
          const levels = ["unrated", ...controller.DIFFICULTIES];
          await difficulty.setProfiles(owner, { commandId: "launcher-local-host-profiles", expectedRevision: 0, profiles: { profiles: { default: { harness: "pi", routingProfile: "default" } }, mapping: Object.fromEntries(levels.map((l) => [l, "default"])) } });
          notes.push("No difficulty profiles were set, so every task now uses the default routing profile (free and local models first). Change that with the difficulty operations.");
        }
      } catch (error) {
        notes.push(`Tasks cannot be matched to a model yet (${safeMessage(error, 200)}); set up the model providers first, then tell the chat how to match task difficulty to them.`);
      }
      heartbeat = setInterval(() => { local.beat(hosts, self).catch((error) => ctx.print(`The worker host on this computer could not report that it is alive: ${safeMessage(error, 200)}`)); }, BEAT_MS);
      heartbeat.unref?.();
      notes.unshift(`The worker host on this computer (${LOCAL_HOST_ID}) is running agents in a sandbox, on the model providers you set up. Tasks assigned to an agent start here.`);
      return notes;
    };
    return { start, attach, close };
  };
}

function isFolder(path) { try { return statSync(path).isDirectory(); } catch { return false; } }
