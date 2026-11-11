import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CatalogService, DeskService, LocalWorker, ModelRelay, SqliteStorage, ToolExecutionService, personalNamespace, type ToolGateway, type WorkOrder } from "@nimblenewt/controller";
import { buildWorld, workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher, appFromRepository, localWorkerParts, scriptRunner, type LaunchRecord, type WorkerApp } from "@nimblenewt/worker";

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
    let code = "";
    const model = await endpoint([
      () => ({ call: { name: "nimblenewt__desk-write", args: { kind: "note", title: "double notes", body: "Doubles the integer n.", visibility: "shared", status: "accepted" }, id: "call_0" } }),
      (text) => { notes = recordIdIn(text); return { call: { name: "nimblenewt__desk-write", args: { kind: "note", title: "double code", body: SOURCE, visibility: "shared", status: "accepted" }, id: "call_0" } }; },
      (text) => { code = recordIdIn(text); return { call: { name: "nimblenewt__tool-register", args: { name: "double", kind: "tool", version: "1.0.0", manifest: MANIFEST, instructionsRecordId: notes, executableRecordId: code }, id: "call_0" } }; },
      (text) => ({ call: { name: "nimblenewt__tool-invoke", args: { tool: /(a_[a-z0-9]+\.double)/.exec(text)![1]!, input: { n: 21 } }, id: "call_0" } }),
      // Card W03: the agent ends its turn with work.end, then reports.
      (text) => ({ call: { name: "nimblenewt__work-end", args: { report: "Doubled 21.", result: "done", note: `Done: ${/result[^0-9]{0,6}42/.test(text.slice(-600)) ? "42" : "no result"}` }, id: "call_0" } }),
      () => ({ text: "Ended." }),
    ]);
    try {
      const { world, dispatcher, ann, attemptId } = await compose({ launcher, directory, runs, storage, model, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }) });

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
      // The model server gave every tool call the same ID (call_0); each write was still its own: the second desk write made a second record instead of being answered as the first.
      assert.ok(notes !== "" && code !== "" && notes !== code, `${notes} ${code}`);
      assert.match(JSON.stringify(model.seen[1]!.body.messages), /<context>\\nCatalogue tools you may use/, "each request opens with the declarations in the volatile context");
      // Launches: the worker process itself, then the script; both confined, the process with the credential only in its start message (not in a launch record).
      const launched = records.slice(before);
      assert.equal(launched.length, 2, JSON.stringify(launched.map((r) => r.mode)));
      assert.ok(launched.every((r) => r.mode === "sandboxed"));
      assert.equal(JSON.stringify(launched).includes("sk-provider-secret"), false);
      assert.deepEqual(readdirSync(runs), [], "the script left nothing behind");

      // The tool registered during the turn was in none of the turn's declarations: every model call of the turn carried the snapshot taken when its request opened. The agent's next request (its next task, a new process)
      // opens with the tool listed.
      const contextOf = (seen: Seen): string => { const all = [...JSON.stringify(seen.body.messages).matchAll(/<context>\\n([\s\S]*?)\\n<\/context>/g)]; assert.equal(all.length, 1, "one volatile context per request"); return all[0]![1]!; };
      const firstTurn = model.seen.length;
      // Five calls: the agent's work.end ends the attempt at once, so the reply after it is never asked for.
      assert.equal(firstTurn, 5);
      for (const seen of model.seen) { const context = contextOf(seen); assert.match(context, /^Catalogue tools you may use/); assert.doesNotMatch(context, /\.double /, "a tool registered during the turn is not declared within it"); }
      const next = await world.task("Double another number", ann);
      const report2 = await dispatcher.tick();
      await dispatcher.idle();
      assert.deepEqual(report2.started, [next.attemptId]);
      // The next task's agent answers in prose only, so its turn is nudged three times (card W04): four calls, each opening with the same declarations.
      assert.equal(model.seen.length, firstTurn + 4);
      assert.match(contextOf(model.seen[firstTurn]!), /\\n- a_[a-z0-9]{16}\.double 1\.0\.0 \(tool\)/, "the next request declares the tool");

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

  test("a tampered worker process holding the task credential reaches no controller service: no controller module, no database file, no network, and over the channel only what the bridge allows that credential", async (t) => {
    const launcher = await open();
    if (launcher === undefined) return t.skip("bubblewrap or a node install it can mount is unusable");
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn t06b tampered ")));
    const runs = join(directory, "runs");
    mkdirSync(runs);
    const db = join(directory, "db.sqlite");
    const storage = await SqliteStorage.open({ path: db });
    // A stand-in for a controller service on this machine's loopback: the process must not reach it.
    const connections: string[] = [];
    const service = createTcpServer((socket) => { connections.push("connected"); socket.destroy(); });
    await new Promise<void>((ok) => service.listen(0, "127.0.0.1", ok));
    const port = (service.address() as { port: number }).port;
    const model = await endpoint([() => ({ call: { name: "nimblenewt__work-end", args: { report: "Done as the task asked.", result: "done", note: "nothing to do" } } }), () => ({ text: "nothing to do" })]);
    // The tampered program: the real worker process, with code of its own that reads the channel beside it, takes the credential from the start message and probes before the turn runs.
    const tampered = join(directory, "tampered");
    mkdirSync(tampered);
    const paths = [db, directory, join(repository, "packages", "controller"), "/opt/app/packages/controller", "/opt/app/packages/worker"];
    writeFileSync(join(tampered, "main.mjs"), TAMPERED.replace("__PATHS__", JSON.stringify([...paths, "/opt/app/packages/pi-adapter"])).replace("__PORT__", String(port)));
    const real = appFromRepository(repository, { root: nodeRoot, executable: "bin/node" });
    const app: WorkerApp = { ...real, mounts: [...real.mounts, { host: tampered, guest: "/opt/tampered" }], entry: "/opt/tampered/main.mjs", hostEntry: join(tampered, "main.mjs") };
    try {
      const { world, dispatcher, attemptId } = await compose({ launcher, directory, runs, storage, model, app });
      const report = await dispatcher.tick();
      await dispatcher.idle();
      assert.deepEqual(report.started, [attemptId]);
      const attempt = await dispatcher.get(world.owner, attemptId);
      const probeFile = join(directory, attemptId, "home", "probe.json");
      assert.ok(existsSync(probeFile), `the tampered process wrote its findings (attempt ${JSON.stringify(attempt)})`);
      const found = JSON.parse(readFileSync(probeFile, "utf8")) as Record<string, any>;
      assert.equal(found["error"], undefined, JSON.stringify(found));
      // The real worker inside the tampered program still ran the turn.
      assert.equal(attempt?.state, "finished", JSON.stringify(attempt));
      assert.equal(attempt?.outcome?.status, "succeeded", JSON.stringify(attempt));
      // No controller or worker module can be resolved or imported, and none of the controller's files is there.
      // (The contracts package, which the process does load, resolves: the probe can tell.)
      assert.deepEqual(found["resolve"], { "@nimblenewt/controller": "missing", "@nimblenewt/worker": "missing", "@nimblenewt/contracts": "found" });
      assert.deepEqual(found["imports"], ["rejected", "rejected"]);
      assert.deepEqual(found["paths"], { ...Object.fromEntries(paths.map((p) => [p, false])), "/opt/app/packages/pi-adapter": true });
      // No network: neither a socket nor a fetch reaches the stand-in service.
      assert.notEqual(found["tcp"], "connected");
      assert.notEqual(found["fetch"], "fetched");
      assert.deepEqual(connections, []);
      // The environment holds nothing but the launcher's own variables, and nothing the process gathered holds the provider's key (H12j scans the channel, files and environment in full).
      for (const key of found["env"] as string[]) assert.ok(["HOME", "PATH", "PWD", "TMPDIR"].includes(key), `unexpected variable ${key}`);
      assert.equal(JSON.stringify(found).includes("sk-provider-secret"), false);
      // Over the channel: an operation that is not the bridge's is refused, a credential that is not the attempt's is refused, and the attempt's own credential is answered by the bridge (as its grants allow).
      assert.equal(found["unknownOp"].ok, false, JSON.stringify(found["unknownOp"]));
      assert.equal(found["unknownOp"].code, "invalid_command");
      assert.equal(found["forged"].ok, false, JSON.stringify(found["forged"]));
      assert.equal(found["forged"].code, "unauthenticated", JSON.stringify(found["forged"]));
      assert.equal(found["own"].ok, true, JSON.stringify(found["own"]));
      assert.ok(Array.isArray(found["own"].result.tools), JSON.stringify(found["own"]));
    } finally {
      model.server.close();
      service.close();
      await storage.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await launcher.stop();
    }
  });
});

/**
 * The tampered worker program (an ES module run as the worker process's entry): it reads the channel itself beside the real worker, takes the task credential from the start message, and before letting the turn run tries every way it
 * has to reach the controller. What it found is written to its home directory. Its own bridge requests use IDs the real worker never reaches, and their replies are kept from the real worker.
 */
const TAMPERED = String.raw`
const WORKER = "/opt/app/packages/pi-adapter/dist/worker/process.js";
const { runWorker } = await import(WORKER);
import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
const PATHS = __PATHS__;
const PORT = __PORT__;
console.log = (...a) => console.error(...a);
const found = {};
const waiting = new Map();
let nextId = 1000000;
let token;
let probed;
const ask = (tok, op, callId, args) => new Promise((resolve) => { const id = ++nextId; waiting.set(id, resolve); process.stdout.write(JSON.stringify({ t: "bridge", id, token: tok, request: { op, callId, args } }) + "\n"); });
const save = () => writeFileSync(process.env.HOME + "/probe.json", JSON.stringify(found));
async function probe() {
  const req = createRequire(WORKER);
  found.resolve = {};
  for (const name of ["@nimblenewt/controller", "@nimblenewt/worker", "@nimblenewt/contracts"]) { try { req.resolve(name); found.resolve[name] = "found"; } catch { found.resolve[name] = "missing"; } }
  const direct = ["controller", "worker"].map((name) => "/opt/app/node_modules/@nimblenewt/" + name + "/dist/index.js");
  found.imports = (await Promise.allSettled(direct.map((file) => import(file)))).map((r) => r.status);
  found.paths = Object.fromEntries(PATHS.map((p) => [p, existsSync(p)]));
  found.tcp = await new Promise((resolve) => { const s = connect({ host: "127.0.0.1", port: PORT }); s.on("connect", () => { s.destroy(); resolve("connected"); }); s.on("error", (e) => resolve(String(e.code ?? "error"))); setTimeout(() => { s.destroy(); resolve("timeout"); }, 3000); });
  found.fetch = await fetch("http://127.0.0.1:" + PORT + "/").then(() => "fetched", (e) => String(e?.cause?.code ?? e?.message ?? e).slice(0, 120));
  found.env = Object.keys(process.env).sort();
  found.unknownOp = await ask(token, "principal.create", "tamper-1", { name: "evil" });
  found.forged = await ask("nn_" + "x".repeat(40), "tool.discover", "tamper-2", { limit: 5 });
  found.own = await ask(token, "tool.discover", "tamper-3", { limit: 5 });
}
const queue = [];
let wake;
let ended = false;
(async () => {
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk.toString("utf8");
    for (let at; (at = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, at + 1);
      buffer = buffer.slice(at + 1);
      let m;
      try { m = JSON.parse(line); } catch { m = undefined; }
      if (m?.t === "bridge.reply" && waiting.has(m.id)) { waiting.get(m.id)(m.reply); waiting.delete(m.id); continue; }
      if (m?.t === "start") { token = m.start.credential; probed = probe().then(save, (e) => { found.error = String(e?.stack ?? e).slice(0, 2000); save(); }); }
      queue.push({ line, run: m?.t === "run" });
      wake?.();
    }
  }
  ended = true;
  wake?.();
})();
async function* input() {
  for (;;) {
    while (queue.length > 0) { const next = queue.shift(); if (next.run) await probed; yield next.line; }
    if (ended) return;
    await new Promise((resolve) => { wake = resolve; });
    wake = undefined;
  }
}
await runWorker({ input: input(), write: (text) => { process.stdout.write(text); } });
process.exit(0);
`;
const personalId = (agentId: string): string => personalNamespace(agentId).slice(2);

/** The composed path of the card: a `ToolExecutionService` over a real launcher's script runner, the agent `ann` with the grants a working agent has (none on its own namespace), a task for her, and a `LocalWorker` that starts `app` as the worker process. */
async function compose(x: { launcher: SandboxLauncher; directory: string; runs: string; storage: SqliteStorage; model: { url: string }; app: WorkerApp }) {
  const { launcher, directory, runs, storage, model, app } = x;
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
    launcher, app, protectedPaths: [],
    workspace: (order) => {
      const dirs = { checkout: join(directory, order.attemptId, "checkout"), gitDir: join(directory, order.attemptId, "git"), home: join(directory, order.attemptId, "home"), scratch: join(directory, order.attemptId, "scratch") };
      for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
      return dirs;
    },
    // 32,768 tokens (card CMP): a small window; Pi's background compaction threshold is scaled for it by the worker, so no unscripted summary call is made between scripted calls.
    model: () => ({ alias: "m0", provider: "llama", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] }),
    namespaceId: (order) => personalId(order.agentId),
    // A reviewer who answers at once: an ask that is parked is approved and the same request is made again with the same call ID.
    bridge: async (order, call, token, request) => {
      // This world has no state API: the agent's work.end (card H12n, W03) ends its attempt directly, as the API operation would.
      if ((request as { op?: string }).op === "work.end") { await dispatcher.finishWith(world.owner, order.attemptId, { result: "done" }); return { ok: true, result: { state: "done" } } as never; }
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
  return { world, dispatcher, ann, attemptId: attemptId!, service };
}
