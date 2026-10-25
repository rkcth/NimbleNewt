import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { LocalWorker, ModelRelay, type ToolGateway, type ToolResult, type WorkOrder } from "@nimblenewt/controller";
import { SandboxLauncher, appFromRepository, localWorkerParts, type LaunchRecord } from "@nimblenewt/worker";

// Card H12b: the real worker process. The controller's LocalWorker drives the local host parts over the real sandbox launcher; the Pi conversation runs in a child process inside bubblewrap with no network, and reaches
// the model only through the controller-side relay, to a scripted OpenAI-compatible endpoint, and the protected bridge only over the channel. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface Seen { path: string; auth: string | undefined; body: { model: string; messages: { role: string; content: unknown }[]; [k: string]: unknown } }
const sse = (delta: object, finish: string | null, usage?: object): string => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) })}\n\n`;

/** The test process blocks the global fetch (the offline guard), so the relay reaches the loopback endpoint through node:http. */
const loopbackFetch: typeof globalThis.fetch = (input, init) => new Promise((ok, fail) => {
  const req = httpRequest(String(input), { method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()) }, (res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers.set(k, v);
    ok(new Response(Readable.toWeb(res) as ReadableStream, { status: res.statusCode ?? 502, headers }));
  });
  req.on("error", fail);
  init?.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")));
  req.end(init?.body === undefined ? undefined : Buffer.from(init.body as Buffer));
});

/** A model endpoint that plays the given replies in order: a reply is a tool call or a text. */
async function endpoint(replies: ({ call: { name: string; args: object } } | { text: string })[]): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  let at = 0;
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", auth: req.headers["authorization"], body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Seen["body"] });
      const reply = replies[Math.min(at++, replies.length - 1)]!;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
      if ("call" in reply) {
        res.write(sse({ role: "assistant", tool_calls: [{ index: 0, id: `call_${at}`, type: "function", function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) } }] }, null));
        res.write(sse({}, "tool_calls", usage));
      } else {
        res.write(sse({ role: "assistant", content: reply.text }, null));
        res.write(sse({}, "stop", usage));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen };
}

describe("the worker process runs the Pi conversation inside the sandbox", () => {
  const records: LaunchRecord[] = [];
  const open = async (): Promise<SandboxLauncher | undefined> => {
    const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: (r) => { records.push(r); } });
    const usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
    if (!usable && required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${launcher.capacity.reason}`);
    return usable ? launcher : undefined;
  };

  test("a turn reaches the model through the relay (key added there), a tool through the bridge with the credential, and ends with a checkpoint and a turn number", async (t) => {
    const launcher = await open();
    if (launcher === undefined) return t.skip("bubblewrap or a node install it can mount is unusable");
    const model = await endpoint([{ call: { name: "nimblenewt__desk-read", args: { recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" } } }, { text: "all done" }]);
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn h12b ")));
    try {
      const dirs = { checkout: join(directory, "checkout"), gitDir: join(directory, "git"), home: join(directory, "home"), scratch: join(directory, "scratch") };
      for (const d of Object.values(dirs)) mkdirSync(d);
      writeFileSync(join(dirs.checkout, "README.md"), "hello\n");
      const bridged: { token: string; op: string; callId: string; args: unknown }[] = [];
      const relay = new ModelRelay({ fetch: loopbackFetch, endpoint: (route) => (route === "llama/local" ? { url: model.url, headers: () => ({ authorization: "Bearer sk-provider-secret" }) } : undefined) });
      const parts = localWorkerParts<unknown>({
        launcher, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
        workspace: () => dirs,
        model: () => ({ alias: "m0", provider: "llama", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] }),
        namespaceId: () => "abcdef0123456789",
        bridge: async (_order, _call, token, request) => { bridged.push({ token, op: request.op, callId: request.callId, args: request.args }); return { ok: true, result: { record: { id: "dsk-aaaaaaaaaaaaaaaaaaaa", body: "x" } } }; },
        relay: (order, request) => relay.forAttempt({ route: order.route, model: "local" }).relay(request),
        requireEnforced: false,
      });
      const worker = new LocalWorker({ hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "test", sandbox: parts.sandbox as never, runtimes: { open: (order, call, from) => parts.runtimes.open(order as never, call, from as never) as never }, capabilities: () => ({}) as never });
      const order: WorkOrder = { attemptId: "att-1", taskId: "t1", projectId: "p1", agentId: "agent:ann", generation: 1, route: "llama/local", credential: "task-credential-1", recipe: { revision: "r1", reach: [] } as never, content: "read the record", requestId: "req-1", expiresAt: new Date(Date.now() + 120_000).toISOString() };
      const handle = await worker.start(order);
      const gateway = { attemptId: "att-1", call: async (): Promise<ToolResult> => { throw new Error("not used"); }, heartbeat: async () => ({ until: order.expiresAt }), usage: async () => undefined, acknowledgeDecisions: async () => undefined } as unknown as ToolGateway;
      const result = await handle.run(gateway);
      await handle.stop();
      assert.equal(result.status, "completed", result.error);
      assert.equal(result.text, "all done");
      assert.equal(result.usage?.turnSeq, 1);
      assert.equal(typeof result.checkpoint, "object");
      // The request opens with a look at the catalogue; the tool call is the other one.
      assert.equal(bridged.filter((b) => b.op === "tool.discover").length, 1);
      bridged.splice(0, bridged.length, ...bridged.filter((b) => b.op !== "tool.discover"));
      assert.equal(bridged.length, 1);
      assert.equal(bridged[0]!.token, "task-credential-1");
      assert.equal(bridged[0]!.op, "desk.read");
      assert.deepEqual(bridged[0]!.args, { recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" });
      assert.equal(model.seen.length, 2, "two model calls: the tool call and the answer");
      assert.ok(model.seen.every((s) => s.auth === "Bearer sk-provider-secret" && s.path === "/v1/chat/completions"), "the provider's key is added by the relay");
      assert.equal(model.seen[0]!.body.model, "local");
      const launched = records.at(-1)!;
      assert.equal(JSON.stringify(launched).includes("sk-provider-secret"), false, "the key is nowhere in the launch record");
    } finally {
      model.server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
