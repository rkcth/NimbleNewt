import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { LocalWorker, ModelRelay, type ToolGateway, type ToolResult, type WorkOrder } from "@nimblenewt/controller";
import { SandboxLauncher, appFromRepository, localWorkerParts } from "@nimblenewt/worker";
import type { RunResult, SandboxRun } from "@nimblenewt/worker";
import { endpoint, loopbackFetch } from "./h12-worker-support.js";

// Card H12j: what the real worker process must leave behind and must never hold. Over the real launcher and the real child: the process is reaped (with everything it started) when the attempt completes, is stopped mid-turn, or is lost;
// and the provider's key is not in the child's environment, its files, its output or the channel in either direction. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const KEY = "sk-provider-SECRET-0123456789abcdef";

interface Tap { readonly runs: { run: SandboxRun; out: string[]; in: string[]; env: Record<string, string> | undefined }[] }

async function rig(t: { skip: (why: string) => void }, model: { url: string }) {
  const real = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = real.capacity.available && real.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  if (!usable && required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${real.capacity.reason}`);
  if (!usable) { t.skip("bubblewrap or a node install it can mount is unusable"); return undefined; }
  const tap: Tap = { runs: [] };
  // The launcher the host sees: the same one, with every byte of the channel recorded in both directions.
  const launcher = {
    launch: async (request: Parameters<SandboxLauncher["launch"]>[0]) => {
      const entry: Tap["runs"][number] = { run: undefined as never, out: [], in: [], env: request.recipe.env as Record<string, string> | undefined };
      const run = await real.launch({ ...request, ...(request.stream === undefined ? {} : { stream: { onStdout: (chunk: Buffer) => { entry.out.push(chunk.toString("utf8")); request.stream!.onStdout(chunk); } } }) });
      entry.run = { ...run, write: async (text: string) => { entry.in.push(text); return run.write(text); }, kill: () => run.kill(), endInput: () => run.endInput(), result: run.result } as SandboxRun;
      tap.runs.push(entry);
      return entry.run;
    },
  };
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn h12j ")));
  const dirs = { checkout: join(directory, "checkout"), gitDir: join(directory, "git"), home: join(directory, "home"), scratch: join(directory, "scratch") };
  for (const d of Object.values(dirs)) mkdirSync(d);
  writeFileSync(join(dirs.checkout, "README.md"), "hello\n");
  const relay = new ModelRelay({ fetch: loopbackFetch, endpoint: (route) => (route === "llama/local" ? { url: model.url, headers: () => ({ authorization: `Bearer ${KEY}` }) } : undefined) });
  const parts = localWorkerParts<unknown>({
    launcher: launcher as never, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
    workspace: () => dirs,
    model: () => ({ alias: "m0", provider: "llama", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] }),
    namespaceId: () => "abcdef0123456789",
    bridge: async () => ({ ok: true, result: { record: { id: "dsk-aaaaaaaaaaaaaaaaaaaa", body: "x" } } }),
    relay: (order, request) => relay.forAttempt({ route: order.route, model: "local" }).relay(request),
    requireEnforced: false,
  });
  const worker = new LocalWorker({ hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "test", sandbox: parts.sandbox as never, runtimes: { open: (order, call, from) => parts.runtimes.open(order as never, call, from as never) as never }, capabilities: () => ({}) as never });
  const order: WorkOrder = { attemptId: "att-1", taskId: "t1", projectId: "p1", agentId: "agent:ann", generation: 1, route: "llama/local", credential: "task-credential-1", recipe: { revision: "r1", reach: [] } as never, content: "read the record", requestId: "req-1", expiresAt: new Date(Date.now() + 120_000).toISOString() };
  const gateway = { attemptId: "att-1", call: async (): Promise<ToolResult> => { throw new Error("not used"); }, heartbeat: async () => ({ until: order.expiresAt }), usage: async () => undefined, acknowledgeDecisions: async () => undefined } as unknown as ToolGateway;
  return { worker, order, gateway, dirs, tap, directory, done: () => rmSync(directory, { recursive: true, force: true }) };
}

const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));

/** A model endpoint that takes the request and never answers (a turn that is still running when the attempt is stopped or lost). */
async function silentModel(): Promise<{ server: Server; url: string; requests: () => number }> {
  let n = 0;
  const server = createServer((req) => { n++; req.resume(); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, requests: () => n };
}
const until = async (ok: () => boolean, ms = 20_000): Promise<void> => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) assert.fail("timed out waiting"); await new Promise((r) => setTimeout(r, 20)); } };

/** Processes of this machine that mention `marker` on their command line (the attempt's private directory appears in the sandbox's and the worker's command lines). Linux only; elsewhere nothing can be said. */
const processesMentioning = (marker: string): string[] => {
  if (process.platform !== "linux") return [];
  const found: string[] = [];
  for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try { if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker)) found.push(pid); } catch { /* gone */ }
  }
  return found;
};

/** The run ended and nothing of its process tree is left: no process anywhere on the machine still carries the attempt's private directory on its command line. */
async function reaped(entry: Tap["runs"][number], marker: string): Promise<RunResult> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([entry.run.result, new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error("the worker process was not reaped within 15 seconds")), 15_000); })]).finally(() => clearTimeout(timer));
  assert.equal(result.releaseProblem, undefined, `the sandbox could not be released: ${String(result.releaseProblem)}`);
  // The sweep after the run may take a moment to finish killing a descendant; none may remain after a short wait.
  const end = Date.now() + 5000;
  while (processesMentioning(marker).length > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(processesMentioning(marker), [], "a process of the attempt is still running");
  return result;
}

describe("the worker process is reaped however the attempt ends, and never holds the provider's key", () => {
  test("no provider key reaches the child's environment, files, output or the channel in either direction; the relay adds it", async (t) => {
    const model = await endpoint([{ call: { name: "nimblenewt__desk-read", args: { recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" } } }, { text: "all done" }]);
    const r = await rig(t, model);
    if (r === undefined) { model.server.close(); return; }
    try {
      const handle = await r.worker.start(r.order);
      const result = await handle.run(r.gateway);
      await handle.stop();
      assert.equal(result.status, "completed", result.error);
      assert.ok(model.seen.length === 2 && model.seen.every((s) => s.auth === `Bearer ${KEY}`), "the relay added the key on the way to the provider");
      const entry = r.tap.runs[0]!;
      const ended = await reaped(entry, r.directory);
      assert.ok(entry.out.length > 0 && entry.in.length > 0, "the channel was observed in both directions");
      const encodings = (k: string): string[] => [k, Buffer.from(k).toString("base64"), Buffer.from(k).toString("base64url"), encodeURIComponent(k), Buffer.from(k).toString("hex")].map((x) => x.replace(/=+$/, ""));
      for (const [what, text] of [["channel from the worker", entry.out.join("")], ["channel to the worker", entry.in.join("")], ["standard error", ended.stderr], ["standard output", ended.stdout], ["launch environment", JSON.stringify(entry.env ?? {})]] as const) {
        for (const form of encodings(KEY)) assert.equal(text.includes(form), false, `the provider key (${form === KEY ? "plain" : "encoded"}) is in the ${what}`);
        assert.equal(text.includes("sk-provider"), false, `part of the provider key is in the ${what}`);
      }
      assert.ok(entry.in.join("").includes("task-credential-1"), "the task credential is what the worker holds (positive control)");
      const files = [r.dirs.home, r.dirs.scratch, r.dirs.checkout].flatMap(filesUnder).filter((f) => statSync(f).size < 20 * 1024 * 1024);
      assert.ok(files.some((f) => f.startsWith(join(r.dirs.home, "pi"))), "the conversation store in the agent's home was scanned");
      for (const file of files) { const bytes = readFileSync(file); for (const form of encodings(KEY)) assert.equal(bytes.includes(form), false, `the provider key (${form === KEY ? "plain" : "encoded"}) is in ${file}`); }
    } finally { model.server.close(); r.done(); }
  });

  test("the process is reaped when the attempt completes, when it is stopped in the middle of a turn, and when it is lost", async (t) => {
    const quick = await endpoint([{ text: "done" }]);
    const first = await rig(t, quick);
    if (first === undefined) { quick.server.close(); return; }
    try {
      // 1. Completion.
      const handle = await first.worker.start(first.order);
      assert.equal((await handle.run(first.gateway)).status, "completed");
      await handle.stop();
      await reaped(first.tap.runs[0]!, first.directory);
    } finally { quick.server.close(); first.done(); }

    // 2. Stopped while the turn is waiting for the model.
    const silent = await silentModel();
    const second = await rig(t, silent);
    try {
      const handle = await second!.worker.start(second!.order);
      const running = handle.run(second!.gateway);
      await until(() => silent.requests() >= 1);
      if (process.platform === "linux") assert.ok(processesMentioning(second!.directory).length > 0, "the check can see the running worker (positive control)");
      await handle.stop();
      const result = await running;
      assert.notEqual(result.status, "completed", "a stopped turn does not report success");
      await reaped(second!.tap.runs[0]!, second!.directory);
    } finally { silent.server.close(); second!.done(); }

    // 3. Lost: the process is killed from outside while the turn runs; the turn fails and nothing is left behind.
    const silent2 = await silentModel();
    const third = await rig(t, silent2);
    try {
      const handle = await third!.worker.start(third!.order);
      const running = handle.run(third!.gateway);
      await until(() => silent2.requests() >= 1);
      third!.tap.runs[0]!.run.kill();
      const result = await running;
      assert.equal(result.status, "failed");
      assert.match(String(result.error), /worker process ended/);
      await reaped(third!.tap.runs[0]!, third!.directory);
      await handle.stop();
    } finally { silent2.server.close(); third!.done(); }
  });
});
