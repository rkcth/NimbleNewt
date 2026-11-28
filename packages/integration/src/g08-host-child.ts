import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HostPoller, LocalWorker, ModelRelay, RemoteOfferRunner, RemoteWorkerClient, type WorkOrder } from "@nimblenewt/controller";
import { SandboxLauncher, appFromRepository, localWorkerParts } from "@nimblenewt/worker";
import { loopbackFetch } from "./h12-worker-support.js";

// Card G08: a remote worker host in a process of its own, so a test can cut its traffic or kill it (the supervisor of the agent's process) from outside. It is the product's remote worker code end to end: the host poller (H07) holds the
// session, the offer runner (L05d) takes the offer and runs it through a `LocalWorker` whose runtime is the worker package's launcher and the Pi process in its bubblewrap sandbox. The lease the controller sends goes to the process as a
// duration and is renewed through the attempt's heartbeat over HTTP (H08b); the tool bridge and the model-call recorder are the attempt's own routes (L05e, L05d). Nothing of the controller runs here. The configuration comes on standard input
// (one JSON line), so the host credential is not on the command line. What the host does is printed as JSON lines; the test does not rely on them for its measurements (it observes the process tree, the network and the store itself).

interface Config { readonly url: string; readonly token: string; readonly directory: string; readonly modelUrl: string; readonly leaseGraceMs: number; readonly timeoutMs: number; readonly retries: number; readonly hostHeader: string }

const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ABILITIES = { formats: [1], features: ["limits", "wall-time"], enforces: { cpus: "full", memoryMb: "full", diskMb: "full", processes: "full", wallTimeMs: "full" } };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const say = (event: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify({ at: Date.now(), ...event })}\n`); };

async function readConfig(): Promise<Config> {
  let text = "";
  for await (const chunk of process.stdin) { text += String(chunk); if (text.includes("\n")) break; }
  return JSON.parse(text.slice(0, text.indexOf("\n"))) as Config;
}

async function main(): Promise<void> {
  const config = await readConfig();
  const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  if (!launcher.capacity.available || launcher.capacity.backend !== "bubblewrap") { say({ ev: "unusable", why: launcher.capacity.reason ?? "no bubblewrap" }); process.exit(3); }
  const client = new RemoteWorkerClient({ url: config.url, token: config.token, workerVersion: "worker-9.1.0", timeoutMs: config.timeoutMs, retries: config.retries, hostHeader: config.hostHeader });
  let runner: RemoteOfferRunner | undefined;
  const relay = new ModelRelay({ fetch: loopbackFetch, endpoint: (route) => (route === "localp/small" ? { url: config.modelUrl, headers: () => ({}) } : undefined) });
  const dirs = (order: WorkOrder) => {
    const base = join(config.directory, "attempts", order.attemptId);
    const made = { checkout: join(base, "checkout"), gitDir: join(base, "git"), home: join(base, "home"), scratch: join(base, "scratch") };
    for (const d of Object.values(made)) mkdirSync(d, { recursive: true });
    return made;
  };
  const parts = localWorkerParts<unknown>({
    launcher, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
    workspace: (order) => dirs(order as never),
    model: () => ({ alias: "m0", provider: "localp", api: "openai-completions", modelId: "local", contextWindow: 131_072, maxTokens: 1024, reasoning: false, input: ["text"] }),
    namespaceId: () => "abcdef0123456789",
    // The machine's tool bridge is the controller's, reached through the attempt (card L05e).
    bridge: async (order, _call, token, request) => await runner!.bridge((order as unknown as WorkOrder).attemptId, token, request as never) as never,
    relay: (order, request) => relay.forAttempt({ route: "localp/small", model: "local", stream: runner!.tap((order as unknown as WorkOrder).attemptId) }).relay(request),
    requireEnforced: false,
    leaseGraceMs: config.leaseGraceMs,
  });
  const local = new LocalWorker({
    hostId: "host:r1", resources: { cpus: 1, memoryMb: 1024 }, version: "g08-host",
    sandbox: parts.sandbox as never,
    // The lease is handed on (the fourth argument): without it the process would run with no watchdog.
    runtimes: { open: (order, call, from, lease) => parts.runtimes.open(order as never, call as never, from as never, lease) as never },
    capabilities: () => CAPS as never,
  });
  runner = new RemoteOfferRunner({ client, host: local, abilities: ABILITIES as never, controlMs: 100, stream: { batchMs: 0, batchChars: 0 }, onTrouble: (attemptId, what, error) => say({ ev: "trouble", attemptId, what, error: String((error as Error)?.message ?? error).slice(0, 200) }) });
  const taken = new Set<string>();
  const poller = new HostPoller({
    client, capabilities: CAPS as never, waitMs: 200, heartbeatMs: 500, minGapMs: 20, spreadMs: 0, baseBackoffMs: 50, maxBackoffMs: 200,
    onOffers: async (offers) => {
      for (const offer of offers) {
        if (taken.has(offer.order.attemptId)) continue;
        taken.add(offer.order.attemptId);
        say({ ev: "offer", attemptId: offer.order.attemptId, placement: offer.placement, leaseMs: offer.order.leaseMs ?? null });
        void runner!.run(offer).then((outcome) => say({ ev: "outcome", attemptId: offer.order.attemptId, outcome }), (error: unknown) => say({ ev: "outcome", attemptId: offer.order.attemptId, outcome: "threw", error: String(error).slice(0, 200) }));
      }
    },
    onTrouble: (e) => say({ ev: "poll-trouble", kind: e.kind, error: String((e.error as Error)?.message ?? e.error).slice(0, 200) }),
  });
  const stop = new AbortController();
  process.on("SIGTERM", () => stop.abort());
  say({ ev: "ready" });
  await poller.run(stop.signal);
}

main().catch((error: unknown) => { say({ ev: "failed", error: String((error as Error)?.stack ?? error).slice(0, 2000) }); process.exit(1); });
