import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CatalogService, DeskService, LocalWorker, ModelRelay, SqliteStorage, ToolExecutionService, personalNamespace, type ToolGateway, type WorkOrder } from "@nimblenewt/controller";
import { buildWorld, workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher, appFromRepository, localWorkerParts, scriptRunner, type LaunchRecord } from "@nimblenewt/worker";

// Card T06b, composed: the whole path with the real worker process. The dispatcher starts a LocalWorker whose conversation runs in a child process inside bubblewrap (no network, no controller module), the model is reached only
// through the relay, and every bridge request crosses the channel to the controller's ToolExecutionService, which runs the registered script through the same launcher. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1.
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const MANIFEST = {
  purpose: "double a number", input: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false }, output: { type: "object", properties: { result: { type: "integer" } }, required: ["result"] },
  entryPoint: "bin/double.js", interpreter: { name: "node", version: process.versions.node }, os: ["linux", "darwin", "win32"], arch: ["x64", "arm64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 512, seconds: 20 }, cancellation: "cooperative", recovery: "none",
};
const SOURCE = `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({result:JSON.parse(s).n*2})));`;
const recordIdIn = (text: string): string => { const all = [...text.matchAll(/"id\\?":\\?"(dsk-[a-z2-7]{20})/g)].map((m) => m[1]!); return all[all.length - 1]!; };

type Reply = { call: { name: string; args: object; id?: string } } | { text: string };
interface Seen { body: { messages: unknown[] } }
const sse = (delta: object, finish: string | null, usage?: object): string => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) })}\n\n`;
async function endpoint(replies: ((text: string) => Reply)[]): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  let at = 0;
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      seen.push({ body: JSON.parse(text) as Seen["body"] });
      const reply = replies[Math.min(at++, replies.length - 1)]!(text);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
      if ("call" in reply) { res.write(sse({ role: "assistant", tool_calls: [{ index: 0, id: reply.call.id ?? `call_${at}`, type: "function", function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) } }] }, null)); res.write(sse({}, "tool_calls", usage)); }
      else { res.write(sse({ role: "assistant", content: reply.text }, null)); res.write(sse({}, "stop", usage)); }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen };
}
/** The offline guard blocks the global fetch, so the relay reaches the loopback endpoint through node:http. */
const loopbackFetch: typeof globalThis.fetch = (input, init) => new Promise((ok, fail) => {
  const req = httpRequest(String(input), { method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()) }, (res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers.set(k, v);
    ok(new Response(Readable.toWeb(res) as ReadableStream, { status: res.statusCode ?? 502, headers }));
  });
  req.on("error", fail);
  req.end(init?.body === undefined ? undefined : Buffer.from(init.body as Buffer));
});

describe("the composed worker: Pi in a sandboxed process, the bridge across the channel, scripts through the launcher", () => {
  const records: LaunchRecord[] = [];
  const open = async (): Promise<SandboxLauncher | undefined> => {
    const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: (r) => { records.push(r); } });
    const usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
    if (!usable && required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${launcher.capacity.reason}`);
    return usable ? launcher : undefined;
  };

  test("an agent registers a script, finds it in the declarations of its next request, and runs it; the process holds only its credential and no controller module", async (t) => {
    const launcher = await open();
    if (launcher === undefined) return t.skip("bubblewrap or a node install it can mount is unusable");
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn t06b composed ")));
    const runs = join(directory, "runs");
    mkdirSync(runs);
    const storage = await SqliteStorage.open({ path: join(directory, "db.sqlite") });
    let notes = "";
    const model = await endpoint([
      () => ({ call: { name: "nimblenewt__desk-write", args: { kind: "note", title: "double notes", body: "Doubles the integer n.", visibility: "shared", status: "accepted" }, id: "call_0" } }),
      (text) => { notes = recordIdIn(text); return { call: { name: "nimblenewt__desk-write", args: { kind: "note", title: "double code", body: SOURCE, visibility: "shared", status: "accepted" }, id: "call_0" } }; },
      (text) => ({ call: { name: "nimblenewt__tool-register", args: { name: "double", kind: "tool", version: "1.0.0", manifest: MANIFEST, instructionsRecordId: notes, executableRecordId: recordIdIn(text) }, id: "call_0" } }),
      (text) => ({ call: { name: "nimblenewt__tool-invoke", args: { tool: /(a_[a-z0-9]+\.double)/.exec(text)![1]!, input: { n: 21 } }, id: "call_0" } }),
      (text) => ({ text: `Done: ${/result[^0-9]{0,6}42/.test(text.slice(-600)) ? "42" : "no result"}` }),
    ]);
    try {
      const world = await buildWorld(storage);
      const desks = DeskService.withEpoch(world.storage, world.epoch, world.options);
      const catalog = CatalogService.withEpoch(world.storage, world.epoch, desks, world.options);
      let dispatcher = world.dispatcher;
      const service = new ToolExecutionService({
        principal: world.dispatcherPrincipal, credentials: world.credentials, dispatch: { get: (...a) => dispatcher.get(...a), toolOperation: (...a) => dispatcher.toolOperation(...a) }, assignments: world.assignments, catalog, hosts: world.hosts, admission: world.admission, pauses: world.pauses, desks,
        runner: scriptRunner({ launcher, interpreters: (name, version) => (name === "node" && version === process.versions.node ? { root: nodeRoot, executable: "bin/node" } : undefined), base: runs, requireEnforced: false }),
        facts: async () => ({ os: "linux", arch: "x64", interpreters: { node: process.versions.node }, packages: {}, cpus: 8, memoryMb: 16_384 }),
        isLocalHost: (hostId) => hostId === "host:w1",
      });
      // No grant for the agent's own tool namespace is given: it comes with enrolment.
      const ann = await world.agent("ann", [...workGrants(world.project), { action: "desk.write", project: world.project }, { action: "desk.read", project: world.project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }]);
      const { attemptId } = await world.task("Double a number with a tool of my own", ann);
      await world.policy.set(world.owner, { scope: "installation", commandId: "pol", profile: "autonomous" });

      const relay = new ModelRelay({ fetch: loopbackFetch, endpoint: () => ({ url: model.url, headers: () => ({ authorization: "Bearer sk-provider-secret" }) }) });
      const parts = localWorkerParts<Pick<ToolGateway, "call">["call"]>({
        launcher, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
        workspace: (order) => {
          const dirs = { checkout: join(directory, order.attemptId, "checkout"), gitDir: join(directory, order.attemptId, "git"), home: join(directory, order.attemptId, "home"), scratch: join(directory, order.attemptId, "scratch") };
          for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
          return dirs;
        },
        model: () => ({ alias: "m0", provider: "llama", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] }),
        namespaceId: (order) => personalId(order.agentId),
        // A reviewer who answers at once: an ask that is parked is approved and the same request is made again with the same call ID.
        bridge: async (order, call, token, request) => {
          const gateway = { attemptId: order.attemptId, call } as Pick<ToolGateway, "attemptId" | "call">;
          const first = await service.handle(token, gateway, request as never);
          if (first.ok && first.result["state"] === "awaiting-approval") {
            const review = (await world.reviews.get(world.owner, first.result["reviewId"] as string))!;
            await world.reviews.decide(world.owner, { commandId: `dec-${request.callId}`, requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "reviewed" });
            return (await service.handle(token, gateway, request as never)) as never;
          }
          return first as never;
        },
        relay: (order, request) => relay.forAttempt({ route: order.route, model: "local" }).relay(request),
        requireEnforced: false,
        // The world runs on a clock of its own; the attempt's time limit is counted on it.
        clock: () => Date.parse(String(world.clock.now())),
      });
      const local = new LocalWorker({ hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "pi-worker-1.0.0", sandbox: parts.sandbox as never, runtimes: { open: (order, call, from) => parts.runtimes.open(order as never, call as never, from as never) as never }, capabilities: () => ({}) as never });
      world.worker.script = async () => ({ status: "failed", error: "unused" });
      dispatcher = world.restart({ workers: [local], replaySafe: service.replaySafe });

      const before = records.length;
      const report = await dispatcher.tick();
      await dispatcher.idle();
      assert.deepEqual(report.started, [attemptId]);
      const ops = (await dispatcher.operations(world.owner, attemptId!))!;
      assert.equal(ops.length, 1);
      assert.equal(ops[0]!.state, "confirmed", JSON.stringify(ops[0]));
      // The model said Done: 42 (its last request carried the script's answer).
      const last = JSON.stringify(model.seen.at(-1)!.body.messages);
      assert.match(last, /result[^0-9]{0,6}42/);
      assert.match(JSON.stringify(model.seen[1]!.body.messages), /<context>\\nCatalogue tools you may use/, "each request opens with the declarations in the volatile context");
      // Launches: the worker process itself, then the script; both confined, the process with the credential only in its start message (not in a launch record).
      const launched = records.slice(before);
      assert.equal(launched.length, 2, JSON.stringify(launched.map((r) => r.mode)));
      assert.ok(launched.every((r) => r.mode === "sandboxed"));
      assert.equal(JSON.stringify(launched).includes("sk-provider-secret"), false);
      assert.deepEqual(readdirSync(runs), [], "the script left nothing behind");

      // The process cannot load the controller or the worker package (they are not in its filesystem) or reach the database: a script with the same mounts as the process proves it.
      for (const d of ["probe-work", "probe-home", "probe-scratch"]) mkdirSync(join(directory, d));
      const probe = await launcher.launch({
        recipe: { mode: "sandboxed", workdir: join(directory, "probe-work"), home: join(directory, "probe-home"), scratch: join(directory, "probe-scratch"), readOnly: [{ host: nodeRoot, guest: "/opt/node" }, ...appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }).mounts], network: "none", env: {}, protectedSubpaths: [] } as never,
        command: ["/opt/node/bin/node", "-e", `Promise.allSettled([import("@nimblenewt/controller"),import("@nimblenewt/worker")]).then(r=>console.log(r.map(x=>x.status).join()))`],
        timeoutMs: 20_000, maxOutputBytes: 10_000, requireEnforced: false,
      });
      assert.match((await probe.result).stdout, /rejected,rejected/, "the controller and the worker package cannot be loaded in the process's filesystem");
    } finally {
      model.server.close();
      await storage.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await launcher.stop();
    }
  });
});
const personalId = (agentId: string): string => personalNamespace(agentId).slice(2);
