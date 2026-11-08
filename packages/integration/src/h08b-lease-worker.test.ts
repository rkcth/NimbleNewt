import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { BridgeReplyMessage } from "@nimblenewt/contracts";
import { LocalWorker, ModelRelay, type ToolGateway, type ToolResult, type WorkOrder } from "@nimblenewt/controller";
import { endpoint, loopbackFetch } from "./h12-worker-support.js";
import { SandboxLauncher, appFromRepository, localWorkerParts } from "@nimblenewt/worker";

// Card H08b: the lease watchdog in the real worker process. The controller's LocalWorker hands the runtime the dispatcher's lease as a duration; the host puts it in the start, the process in the sandbox counts it on its own clock, renews it over
// the channel (each renewal is a heartbeat through the attempt's gateway), and stops when the controller answers fenced; the host ends the process when the grace is over. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1.
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("the worker process keeps its lease by renewing it and stops when it is fenced (card H08b)", () => {
  test("a turn longer than the lease goes on while renewals are answered; a fenced renewal stops it, and no model call leaves afterwards", async (t) => {
    const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
    const usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
    if (!usable && required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${launcher.capacity.reason}`);
    if (!usable) return t.skip("bubblewrap or a node install it can mount is unusable");
    const model = await endpoint([{ call: { name: "nimblenewt__desk-read", args: { recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" } } }, { text: "never reached" }]);
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn h08b ")));
    let answer: ((reply: BridgeReplyMessage) => void) | undefined;
    try {
      const dirs = { checkout: join(directory, "checkout"), gitDir: join(directory, "git"), home: join(directory, "home"), scratch: join(directory, "scratch") };
      for (const d of Object.values(dirs)) mkdirSync(d);
      const relay = new ModelRelay({ fetch: loopbackFetch, endpoint: (route) => (route === "llama/local" ? { url: model.url, headers: () => ({}) } : undefined) });
      const graceMs = 2000;
      const parts = localWorkerParts<unknown>({
        launcher, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
        workspace: () => dirs,
        model: () => ({ alias: "m0", provider: "llama", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] }),
        namespaceId: () => "abcdef0123456789",
        // The tool call waits until the test lets it go (it never does before the fence): the turn outlives the lease many times over.
        bridge: async (_order, _call, _token, request) => (request.op === "tool.discover" ? { ok: true, result: { revision: "r1", tools: [] } } : await new Promise<BridgeReplyMessage>((resolve) => { answer = resolve; })),
        relay: (order, request) => relay.forAttempt({ route: order.route, model: "local" }).relay(request),
        requireEnforced: false,
        leaseGraceMs: graceMs,
      });
      const worker = new LocalWorker({ hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "test", sandbox: parts.sandbox as never, runtimes: { open: (order, call, from, lease) => parts.runtimes.open(order as never, call, from as never, lease) as never }, capabilities: () => ({}) as never });
      const order: WorkOrder = { attemptId: "att-1", taskId: "t1", projectId: "p1", agentId: "agent:ann", generation: 1, route: "llama/local", credential: "task-credential-1", recipe: { revision: "r1", reach: [] } as never, content: "read the record", requestId: "req-1", leaseMs: 1500 };
      const beats: number[] = [];
      let fenced: number | undefined;
      const gateway = {
        attemptId: "att-1", call: async (): Promise<ToolResult> => { throw new Error("not used"); }, usage: async () => undefined, acknowledgeDecisions: async () => undefined,
        heartbeat: async () => {
          if (fenced !== undefined) throw Object.assign(new Error("attempt att-1 is not the active attempt of its task at the current generation; it may not run"), { code: "fenced" });
          beats.push(Date.now());
          // The `until` is a year off on purpose: the process counts the duration, not this time.
          return { until: new Date(Date.now() - 365 * 24 * 3600_000).toISOString(), leaseMs: 1500 };
        },
      } as unknown as ToolGateway;
      const handle = await worker.start(order);
      const running = handle.run(gateway);
      for (let i = 0; i < 200 && answer === undefined; i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(answer !== undefined, "the turn reached the tool call");
      // Three times the lease: renewals (every second) keep it.
      await new Promise((r) => setTimeout(r, 4500));
      assert.ok(beats.length >= 3, `renewed ${beats.length} times`);
      fenced = Date.now();
      const result = await running;
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /lease lost \(explicit\)/);
      const stoppedAfter = Date.now() - fenced;
      assert.ok(stoppedAfter < 2500, `the turn stopped ${stoppedAfter} ms after the fence (a renewal is asked every second)`);
      assert.equal(model.seen.length, 1, "no model call left the process after the fence");
      // The process wound down after telling the host; stopping the attempt ends it (the host's own end after the grace is covered in the worker package's process tests).
      const exited = await Promise.race([new Promise<string>((r) => { setTimeout(() => r("still running"), graceMs + 3000); }), (async () => { await handle.stop(); return "stopped"; })()]);
      assert.equal(exited, "stopped");
    } finally {
      answer?.({ ok: true, result: {} });
      model.server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
