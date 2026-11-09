import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { LocalWorker, ModelRelay, type ToolGateway, type ToolResult, type WorkOrder } from "@nimblenewt/controller";
import { endpoint, loopbackFetch } from "./h12-worker-support.js";
import { SandboxLauncher, appFromRepository, localWorkerParts } from "@nimblenewt/worker";

// Card W02: how a turn ended, from the real worker process (in the sandbox, no network) through the real host and the controller's LocalWorker. A scripted OpenAI-compatible endpoint plays each ending: a reply cut off at the
// output limit, a thinking-only reply, a plain stop without work.end, a reply that announces a step and stops, and a turn that ends with work.end. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("each turn's ending is classified by the worker process and carried to the controller (card W02)", () => {
  const open = async (): Promise<SandboxLauncher | undefined> => {
    const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
    const usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
    if (!usable && required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${launcher.capacity.reason}`);
    return usable ? launcher : undefined;
  };

  const cases: { name: string; replies: Parameters<typeof endpoint>[0]; endKind: string; visibleChars: number; ops?: readonly string[] }[] = [
    { name: "a reply cut off at the output limit", replies: [{ text: "The report so far: step one is", finish: "length" }], endKind: "length", visibleChars: 30 },
    { name: "a thinking-only reply", replies: [{ thinking: "I should look at the parser next." }], endKind: "empty-visible-text", visibleChars: 0 },
    { name: "a natural stop without work.end", replies: [{ text: "The parser is fixed and the tests pass." }], endKind: "no-work-end", visibleChars: 39 },
    { name: "an announced step and no tool call", replies: [{ text: "I fixed the parser. Now let me run the tests:" }], endKind: "announced-step-without-tool-call", visibleChars: 45 },
    { name: "a turn ended with work.end", replies: [{ call: { name: "nimblenewt__work-end", args: { result: "done", note: "parser fixed" } } }, { text: "Ended: the parser is fixed." }], endKind: "normal", visibleChars: 27, ops: ["work.end"] },
  ];

  for (const c of cases) {
    test(`${c.name} is ${c.endKind}`, async (t) => {
      const launcher = await open();
      if (launcher === undefined) return t.skip("bubblewrap or a node install it can mount is unusable");
      const model = await endpoint(c.replies);
      const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn w02 ")));
      try {
        const dirs = { checkout: join(directory, "checkout"), gitDir: join(directory, "git"), home: join(directory, "home"), scratch: join(directory, "scratch") };
        for (const d of Object.values(dirs)) mkdirSync(d);
        writeFileSync(join(dirs.checkout, "README.md"), "hello\n");
        const bridged: { op: string; args: unknown }[] = [];
        const relay = new ModelRelay({ fetch: loopbackFetch, endpoint: (route) => (route === "llama/local" ? { url: model.url, headers: () => ({ authorization: "Bearer sk-provider-secret" }) } : undefined) });
        const parts = localWorkerParts<unknown>({
          launcher, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
          workspace: () => dirs,
          model: () => ({ alias: "m0", provider: "llama", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] }),
          namespaceId: () => "abcdef0123456789",
          bridge: async (_order, _call, _token, request) => {
            if (request.op === "tool.discover") return { ok: true, result: { revision: "r1", tools: [] } };
            bridged.push({ op: request.op, args: request.args });
            return { ok: true, result: { item: { state: "requested" } } };
          },
          relay: (order, request) => relay.forAttempt({ route: order.route, model: "local" }).relay(request),
          requireEnforced: false,
        });
        const worker = new LocalWorker({ hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "test", sandbox: parts.sandbox as never, runtimes: { open: (order, call, from) => parts.runtimes.open(order as never, call, from as never) as never }, capabilities: () => ({}) as never });
        const order: WorkOrder = { attemptId: "att-1", taskId: "t1", projectId: "p1", agentId: "agent:ann", generation: 1, route: "llama/local", credential: "task-credential-1", recipe: { revision: "r1", reach: [] } as never, content: "fix the parser", requestId: "req-1", expiresAt: new Date(Date.now() + 120_000).toISOString() };
        const handle = await worker.start(order);
        const gateway = { attemptId: "att-1", call: async (): Promise<ToolResult> => { throw new Error("not used"); }, heartbeat: async () => ({ until: order.expiresAt }), usage: async () => undefined, acknowledgeDecisions: async () => undefined } as unknown as ToolGateway;
        const result = await handle.run(gateway);
        await handle.stop();
        assert.equal(result.status, "completed", result.error);
        assert.equal(result.endKind, c.endKind);
        assert.equal(result.visibleChars, c.visibleChars);
        assert.deepEqual(bridged.map((b) => b.op), c.ops ?? []);
        if (c.ops !== undefined) assert.deepEqual(bridged[0]!.args, { result: "done", note: "parser fixed" });
      } finally {
        model.server.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
