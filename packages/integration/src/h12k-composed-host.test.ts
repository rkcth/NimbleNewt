import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AdmissionService, DifficultyService, HostService, LocalWorker, ModelRelay, PolicyService, startController, type ToolGateway, type WorkOrder } from "@nimblenewt/controller";
import { EXEC_PROFILES, PI, ROUTING_TABLE, selfSigned, workGrants } from "@nimblenewt/controller/testing";
import { GitBridge, LocalWorkspaces, SandboxLauncher, appFromRepository, localWorkerParts, ownerPolicyOptions } from "@nimblenewt/worker";
import { loopbackFetch, sse } from "./h12-worker-support.js";

// Card H12k, end to end: startController composes the local worker host. The host is the real one (the bubblewrap launcher, the worker process running Pi, the controller's model relay, the message, pause and context
// guards and the owner's limits from the services the controller hands `build`), its checkout is made by the production workspace port, and every tool request of the agent crosses the channel to the controller's
// real tool bridge. The attempt is made quiet around an integration of its checkout, and the controller's MCP client reaches a remote server only at the address the connector checked.
// Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI), where it fails instead.
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENT = "agt-abcdefghijklmnopqrst";
const PUBLIC = "93.184.216.34";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms: number, why: string | (() => string)): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(typeof why === "function" ? why() : why); await sleep(50); } };
const gate = (): { promise: Promise<void>; open: () => void } => { let open!: () => void; const promise = new Promise<void>((r) => { open = r; }); return { promise, open }; };
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

interface Step { readonly text?: string; readonly call?: { readonly name: string; readonly args: object }; readonly hold?: Promise<void> }
/** A model endpoint that plays the steps in order; a step with `hold` answers only once it is released. */
async function model(steps: Step[]): Promise<{ server: Server; url: string; seen: string[]; auth: string[] }> {
  const seen: string[] = [];
  const auth: string[] = [];
  let at = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push(JSON.stringify((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: unknown }).messages));
      auth.push(String(req.headers.authorization));
      const step = steps[Math.min(at++, steps.length - 1)]!;
      void (async () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sse({ role: "assistant", content: "" }, null));
        if (step.hold !== undefined) await step.hold;
        const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
        if (step.call !== undefined) { res.write(sse({ tool_calls: [{ index: 0, id: `call_${at}`, type: "function", function: { name: step.call.name, arguments: JSON.stringify(step.call.args) } }] }, null)); res.write(sse({}, "tool_calls", usage)); }
        else { res.write(sse({ content: step.text ?? "done" }, null)); res.write(sse({}, "stop", usage)); }
        res.end("data: [DONE]\n\n");
      })();
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen, auth };
}

/** A remote MCP server over TLS for `mcp.example.com` (streamable HTTP, JSON answers): one tool, `lookup`. It records what reached it. */
async function mcpServer(): Promise<{ server: Server; port: number; ca: string; seen: { method: string; host: string; url: string }[] }> {
  const cert = selfSigned(new Date(), { dns: "mcp.example.com", ip: false });
  const seen: { method: string; host: string; url: string }[] = [];
  const server = createHttpsServer({ cert: cert.cert, key: cert.key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const m = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { id?: number; method?: string; params?: { arguments?: { q?: string } } };
      seen.push({ method: m.method ?? req.method ?? "", host: String(req.headers.host), url: req.url ?? "" });
      if (m.id === undefined) { res.writeHead(202); res.end(); return; }
      const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "docs", version: "1" } } : { content: [{ type: "text", text: `seed catalogue: ${m.params?.arguments?.q ?? ""}` }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server: server as unknown as Server, port: (server.address() as { port: number }).port, ca: cert.cert, seen };
}

test("the composed local host runs an attempt through the real relay, guards and tool bridge, is made quiet around an integration of its checkout, and the controller reaches a remote MCP server only at a checked public address (card H12k)", { skip: hasGit ? false : "git is not installed" }, async (t) => {
  const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${launcher.capacity.reason}`);
    return t.skip("bubblewrap or a node install it can mount is unusable (the macOS and Windows runs are card H12r)");
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn h12k composed ")));
  // The project's shared repository and the production workspace port, which makes each task's checkout and carries out the integration.
  const shared = join(directory, "shared");
  mkdirSync(join(shared, "src"), { recursive: true });
  sh(directory, "init", "-q", "-b", "main", shared);
  writeFileSync(join(shared, "src", "a.ts"), "export const a = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(directory, "git-scratch") });
  let local: LocalWorker | undefined;
  const ws = new LocalWorkspaces({ root: join(directory, "work"), git, shared: () => shared, busy: () => local?.busyAttempts() ?? [], landing: () => ({ branch: "main", requirePermit: false }) });

  // The agent's second tool request is held at the bridge until the integration is under way; what the host saw is logged in order.
  const log: string[] = [];
  const bridgeHeld = gate(); const bridgeGo = gate(); const integrated = gate();
  let bridgeReply: Promise<unknown> | undefined;
  let bridged = 0;
  const lastStep = gate();
  const answer = await model([
    { call: { name: "nimblenewt__desk-write", args: { kind: "note", title: "seed plan", body: "Order tomato seeds.", visibility: "shared", status: "accepted" } } },
    { call: { name: "nimblenewt__desk-write", args: { kind: "note", title: "second note", body: "Water on Fridays.", visibility: "shared", status: "accepted" } } },
    { text: "all done", hold: lastStep.promise },
  ]);
  const mcp = await mcpServer();
  const dialed: string[] = [];
  const answers: Record<string, string[][]> = {};
  const lookups: Record<string, number> = {};
  let built: { readonly mcp?: { readonly client: unknown; readonly connector: unknown } } | undefined;
  let c: Awaited<ReturnType<typeof startController>> | undefined;
  try {
    c = await startController({
      storage: { kind: "sqlite", path: join(directory, "c.sqlite") }, argv: [], env: {}, print: () => undefined,
      facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [PI],
      tools: { runner: { run: async () => { throw new Error("no script runs in this test"); } } as never, isLocalHost: (hostId) => hostId === "host:w1" },
      dispatch: {
        manual: true,
        mcp: {
          resolve: async (host) => { const list = answers[host] ?? [[]]; const n = lookups[host] = (lookups[host] ?? 0) + 1; return list[Math.min(n, list.length) - 1]!; },
          // The socket for the checked address reaches the local test server; the address asked for is recorded. TLS is checked against the name with the test CA.
          transport: { ca: mcp.ca, dial: (to) => { dialed.push(`${to.address}:${to.port}`); return netConnect({ host: "127.0.0.1", port: mcp.port }); } },
        },
        local: {
          window: () => 32768,
          build: (services) => {
            built = services;
            const relay = new ModelRelay({ fetch: loopbackFetch, endpoint: (route) => (route === "localp/small" ? { url: answer.url, headers: () => ({ authorization: "Bearer sk-provider-secret" }) } : undefined) });
            const parts = localWorkerParts<Pick<ToolGateway, "call">["call"]>({
              launcher, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
              // The checkout and its git directory come from the workspace port; home and scratch are the attempt's own.
              workspace: async (order) => {
                const o = order as unknown as WorkOrder;
                const made = await ws.ensure({ taskId: o.taskId, projectId: o.projectId });
                const home = join(directory, "attempts", o.attemptId, "home"), scratch = join(directory, "attempts", o.attemptId, "scratch");
                mkdirSync(home, { recursive: true }); mkdirSync(scratch, { recursive: true });
                return { checkout: made.checkout, gitDir: made.gitDir, home, scratch };
              },
              model: () => ({ alias: "m0", provider: "localp", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] }),
              // The agent's own namespace and the controller's own tool bridge (ToolExecutionService), both as the composer hands them to the host builder (card T06b).
              namespaceId: (order) => services.namespaceId(order as never),
              bridge: async (order, call, token, request) => {
                const run = () => services.bridge!(order as never, call, token, request) as never;
                if (request.op !== "desk.write" || ++bridged !== 2) return run();
                bridgeHeld.open();
                await bridgeGo.promise;
                // The request reaches the controller during the integration; its answer goes back to the agent only once the integration is done (an agent given an answer makes its next model call at once, and
                // a model call in flight makes the host refuse the integration, which is the host's fail-closed check, not what this test is about).
                bridgeReply = Promise.resolve(run()).then((r: unknown) => { log.push(`bridge:${JSON.stringify(r).slice(0, 300)}`); return r; });
                const reply = await bridgeReply;
                await integrated.promise;
                return reply as never;
              },
              relay: (order, request) => services.attemptRelay(order as never, relay, { model: "local" }).relay(request),
              context: (order) => services.context(order as never),
              heldForReview: (order) => c!.dispatch!.dispatcher.heldForReview(order.attemptId),
              ...ownerPolicyOptions(services),
            });
            local = new LocalWorker({
              hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "h12k-test", guards: services.guards, ownerPolicy: parts.ownerPolicy,
              schedule: (beat) => { const timer = setInterval(() => { void beat(); }, 100); return () => clearInterval(timer); },
              sandbox: parts.sandbox as never, runtimes: { open: (order, call, from) => parts.runtimes.open(order as never, call, from as never) as never },
              // The integration is carried out by the workspace port while the attempt is quiet; the held tool request is let go first, so it reaches a frozen attempt.
              workspace: { run: async (call) => {
                const d = await c!.dispatch!.dispatcher.get(c!.dispatch!.principal, call.quietAttempts?.[0] ?? "");
                log.push(`host:${call.operation}:frozen=${d?.frozen !== undefined}:busy=${JSON.stringify(await local!.busyAttempts())}`);
                bridgeGo.open();
                await until(() => bridgeReply !== undefined, 20_000, "the held tool request never went on");
                await bridgeReply;
                try { return await ws.port.run(call); } finally { integrated.open(); }
              } },
              capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }) as never,
            });
            return local;
          },
        },
      },
    });
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    assert.ok(c.tools !== undefined);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" } } } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    await local!.register(HostService.withEpoch(c.storage, c.epoch, s.assignments), await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token));
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: AGENT, grants: [...workGrants(project), { action: "desk.write", project }, { action: "desk.read", project }, { action: "message.receive", project }] });
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Plan the seed order" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;

    // ---- the attempt runs: the first model call goes out through the relay (the key added there) and the first tool request through the real bridge --------------------------------------------------
    assert.deepEqual((await c.dispatch.dispatcher.tick()).started, [attemptId]);
    await until(() => answer.seen.length >= 2, 60_000, () => `the first tool result never reached the model: ${answer.seen.length} call(s)`);
    assert.match(answer.seen[1]!, /dsk-[a-z2-7]{20}/, "the desk record written through the bridge came back to the agent");
    const admissions = await c.storage.listAggregates("ctx-admission", { limit: 10 });
    assert.equal(admissions.length, 1, "the first model call was admitted by the context check");
    assert.ok(answer.auth.every((h) => h === "Bearer sk-provider-secret"), "the provider's key was added by the relay (the process never holds it)");

    // ---- the agent's work is in its checkout (made by the workspace port); its next tool request is at the bridge ---------------------------------------------------------------------------------------
    await bridgeHeld.promise;
    // The message guard: an urgent message from the owner is delivered to the running attempt (and marked delivered) while it waits at the bridge.
    const sent = await c.api.handle(boot.token, { v: 1, op: "message.send", commandId: "m1", args: { taskId, to: `agent:${AGENT}`, class: "urgent-control", purpose: "safety", text: "keep the seed list short" } } as never) as { ok: boolean };
    assert.equal(sent.ok, true, JSON.stringify(sent));
    await until(async () => { const r = await c!.api.handle(boot.token, { v: 1, op: "message.inbox", args: { recipient: `agent:${AGENT}` } } as never) as { result?: { item?: { items: unknown[] } } }; return (r.result?.item?.items.length ?? 1) === 0; }, 20_000, "the message was never delivered to the running attempt");
    const made = await ws.ensure({ taskId, projectId: project });
    writeFileSync(join(made.checkout, "src", "a.ts"), "export const a = 2; // the agent's work\n");
    const before = sh(shared, "rev-parse", "HEAD");
    const integ = await c.api.handle(boot.token, { v: 1, op: "workspace.request", commandId: "int-1", args: { operation: "integration", taskId, reason: "ready to share" } } as never) as { ok: boolean; result?: { state: string; quietAttempts?: string[]; told?: string[]; detail?: { written?: number } } };
    assert.equal(integ.ok, true, JSON.stringify(integ));
    assert.equal(integ.result!.state, "done", `${JSON.stringify(integ)} | ${log.join(" | ")}`);
    assert.deepEqual(integ.result!.quietAttempts, [attemptId], "the running attempt was made quiet");
    assert.equal(log[0], "host:integration:frozen=true:busy=[]", "the host carried the integration out while the attempt was frozen and nothing of it was in flight");
    assert.match(log[1] ?? "", /frozen/, "the tool request that arrived during the integration was refused, not run");
    assert.equal(integ.result!.detail?.written, 1);
    assert.equal(readFileSync(join(shared, "src", "a.ts"), "utf8"), "export const a = 2; // the agent's work\n", "the agent's work reached the shared tree");
    assert.equal(sh(shared, "rev-parse", "HEAD"), before, "integration makes no commit");
    assert.deepEqual(integ.result!.told, [attemptId], "the running agent was told its checkout was integrated");
    assert.equal((await c.dispatch.dispatcher.get(c.dispatch.principal, attemptId))!.frozen, undefined, "the attempt is released and goes on");
    // The refusal reached the agent, whose next model call is made after the release (and the attempt is still running, held at the model).
    await until(() => answer.seen.length >= 3, 30_000, "the agent never made its next model call");
    assert.match(answer.seen[2]!, /frozen/);
    lastStep.open();
    await c.dispatch.dispatcher.idle();
    assert.equal((await c.dispatch.dispatcher.get(c.dispatch.principal, attemptId))!.state, "finished");
    assert.equal(JSON.stringify(await c.storage.listAggregates("worker-limits-enforced", { limit: 10 })).includes("started"), true, "the launch was recorded through the owner's policy services");

    // ---- the remote MCP server is reached only at the checked public address -------------------------------------------------------------------------------------------------------------------------
    const handle = c.dispatch.mcp!;
    assert.equal(built?.mcp?.client, handle.client, "the host was built with the same MCP client the controller holds");
    assert.equal(built?.mcp?.connector, handle.connector);
    const server = (await handle.service.register(owner, { commandId: "mcp-reg", name: "docs", mode: "remote", transport: "streamable-http", protocolRevision: "2025-06-18", sdk: { name: "@modelcontextprotocol/sdk", version: "1.12.0" }, remote: { url: "https://mcp.example.com:8443/mcp", credentialRef: "docs.token", scopes: ["docs:read"] }, audience: [project], allowed: { tools: ["lookup"] } } as never)).id;
    answers["mcp.example.com"] = [[PUBLIC]];
    assert.deepEqual(await handle.client.callTool(server, "lookup", { q: "tomato" }), { content: [{ type: "text", text: "seed catalogue: tomato" }], isError: false });
    assert.ok(dialed.length > 0 && dialed.every((d) => d === `${PUBLIC}:8443`), `every connection went to the checked address: ${dialed.join(", ")}`);
    assert.ok(mcp.seen.every((x) => x.host === "mcp.example.com:8443" && x.url === "/mcp"), JSON.stringify(mcp.seen));
    assert.deepEqual(mcp.seen.map((x) => x.method), ["initialize", "notifications/initialized", "tools/call"]);
    // A name that turns internal at the second look (DNS rebinding), or is internal from the start: refused, and nothing is dialed.
    for (const list of [[[PUBLIC], ["127.0.0.1"]], [["10.0.0.5"]]]) {
      answers["mcp.example.com"] = list; lookups["mcp.example.com"] = 0;
      const dials: number = dialed.length; const reached: number = mcp.seen.length;
      await assert.rejects(handle.client.callTool(server, "lookup", { q: "x" }), /internal address/);
      assert.equal(dialed.length, dials); assert.equal(mcp.seen.length, reached);
    }
    // A revoked server gets no new connection.
    answers["mcp.example.com"] = [[PUBLIC]]; lookups["mcp.example.com"] = 0;
    await handle.service.revoke(owner, { commandId: "m-rv", serverId: server, expectedRevision: 1 });
    await assert.rejects(handle.client.callTool(server, "lookup", { q: "x" }), /revoked; no new connection/);
    assert.equal(mcp.seen.length, 3);
  } finally {
    lastStep.open(); bridgeGo.open(); integrated.open();
    answer.server.closeAllConnections(); answer.server.close(); mcp.server.close();
    await c?.close();
    await launcher.stop();
    try { execFileSync("chmod", ["-R", "u+rwX", directory]); } catch { /* nothing to open */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
