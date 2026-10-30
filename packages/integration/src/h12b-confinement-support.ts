import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalWorker, ModelRelay, type ToolGateway, type ToolResult, type WorkOrder } from "@nimblenewt/controller";
import { SandboxLauncher, appFromRepository, localWorkerParts, type ResourceLimits } from "@nimblenewt/worker";
import { loopbackFetch } from "./h12-worker-support.js";

// Shared by the confinement test and its crash fixture (card H12b): one real worker process in the real sandbox whose model never answers, so it stays alive for the test to look at.
export const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A model endpoint that takes the request and never answers. */
export async function silentModel(): Promise<{ server: Server; url: string }> {
  const server = createServer((req) => { req.resume(); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
}

export interface Confined {
  readonly directory: string;
  readonly dirs: { checkout: string; gitDir: string; home: string; scratch: string };
  /** The launch records the launcher audited: how each limit was enforced. */
  readonly records: { limits?: readonly { limit: string; enforced: string; by?: string }[] }[];
  /** Starts the attempt; the turn it begins never ends. */
  begin(): Promise<{ stop(): Promise<void> }>;
  done(): void;
}

/** The real launcher over the real backend, or undefined (with the reason) when this machine cannot confine a worker. */
export async function confined(model: { url: string }, limits: ResourceLimits | undefined, requireEnforced: boolean): Promise<Confined | { unusable: string }> {
  const records: Confined["records"] = [];
  const real = await SandboxLauncher.create({ protectedPaths: [], audit: (record: unknown) => { records.push(record as never); } });
  if (!(real.capacity.available && real.capacity.backend === "bubblewrap") || ["/usr", "/bin", "/lib"].includes(nodeRoot)) return { unusable: real.capacity.reason ?? "bubblewrap or a node install it can mount is unusable" };
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn h12bc ")));
  const dirs = { checkout: join(directory, "checkout"), gitDir: join(directory, "git"), home: join(directory, "home"), scratch: join(directory, "scratch") };
  for (const d of Object.values(dirs)) mkdirSync(d);
  writeFileSync(join(dirs.checkout, "README.md"), "hello\n");
  // The checkout names its separate git directory, as a task checkout does; the sandbox protects that name.
  writeFileSync(join(dirs.checkout, ".git"), `gitdir: ${dirs.gitDir}\n`);
  const launcher = real;
  const relay = new ModelRelay({ fetch: loopbackFetch, endpoint: (route) => (route === "llama/local" ? { url: model.url, headers: () => ({}) } : undefined) });
  const parts = localWorkerParts<unknown>({
    launcher: launcher as never, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
    workspace: () => ({ ...dirs, ...(limits === undefined ? {} : { limits }) }),
    model: () => ({ alias: "m0", provider: "llama", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] }),
    namespaceId: () => "abcdef0123456789",
    bridge: async () => ({ ok: true, result: { record: { id: "dsk-aaaaaaaaaaaaaaaaaaaa", body: "x" } } }),
    relay: (order, request) => relay.forAttempt({ route: order.route, model: "local" }).relay(request),
    requireEnforced,
  });
  const worker = new LocalWorker({ hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "test", sandbox: parts.sandbox as never, runtimes: { open: (order, call, from) => parts.runtimes.open(order as never, call, from as never) as never }, capabilities: () => ({}) as never });
  const order: WorkOrder = { attemptId: "att-1", taskId: "t1", projectId: "p1", agentId: "agent:ann", generation: 1, route: "llama/local", credential: "task-credential-1", recipe: { revision: "r1", reach: [] } as never, content: "read the record", requestId: "req-1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const gateway = { attemptId: "att-1", call: async (): Promise<ToolResult> => { throw new Error("not used"); }, heartbeat: async () => ({ until: order.expiresAt }), usage: async () => undefined, acknowledgeDecisions: async () => undefined } as unknown as ToolGateway;
  return {
    directory, dirs, records,
    begin: async () => { const handle = await worker.start(order); void handle.run(gateway).catch(() => undefined); return { stop: async () => { await handle.stop(); } }; },
    done: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** Every process below the given ones (children, grandchildren...), by parent id. Linux only. */
export const descendantsOf = (roots: readonly string[]): { pid: string; comm: string }[] => {
  const parent = new Map<string, string>();
  for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); parent.set(pid, stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]!); } catch { /* gone */ }
  }
  const out: { pid: string; comm: string }[] = [];
  const seen = new Set(roots);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of parent) if (!seen.has(pid) && seen.has(ppid)) {
      seen.add(pid); grew = true;
      try { out.push({ pid, comm: readFileSync(`/proc/${pid}/comm`, "utf8").trim() }); } catch { /* gone */ }
    }
  }
  return out;
};

/** Processes whose command line mentions `marker` (the attempt's private directory), Linux only. */
export const processesMentioning = (marker: string): { pid: string; comm: string }[] => {
  const found: { pid: string; comm: string }[] = [];
  for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try { if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker)) found.push({ pid, comm: readFileSync(`/proc/${pid}/comm`, "utf8").trim() }); } catch { /* gone */ }
  }
  return found;
};
