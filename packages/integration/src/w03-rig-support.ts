import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { AdmissionService, DifficultyService, HostService, LocalWorker, ModelRelay, PolicyService, startController, type ToolGateway, type WorkOrder } from "@nimblenewt/controller";
import { EXEC_PROFILES, PI, ROUTING_TABLE, workGrants } from "@nimblenewt/controller/testing";
import { GitBridge, LocalWorkspaces, SandboxLauncher, appFromRepository, doneVerifier, localWorkerParts, ownerPolicyOptions } from "@nimblenewt/worker";
import { loopbackFetch, sse } from "./h12-worker-support.js";

// Shared by the composed tests of cards W03, W04 and W05: the composed controller with the real local worker (bubblewrap, the worker process running Pi), the real checkout layout and a scripted OpenAI-compatible endpoint.
export const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENT = "agt-abcdefghijklmnopqrst";
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

/** One scripted reply: a text (a natural stop), a tool call, or thinking only with no visible text (card W04). */
export interface Step { readonly text?: string; readonly call?: { readonly name: string; readonly args: object }; readonly thinking?: string; /** Run before the reply is sent (the call is open meanwhile). */ readonly before?: () => Promise<void>; /** The text reply is cut off at the output limit (`finish_reason: length`, card W07). */ readonly length?: boolean }
async function model(steps: Step[]): Promise<{ server: Server; url: string; seen: string[]; bodies: Record<string, unknown>[] }> {
  const seen: string[] = [];
  // Every request body as the provider received it (card W07 checks the route's budget here, at the far side of the relay).
  const bodies: Record<string, unknown>[] = [];
  let at = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      bodies.push(body);
      seen.push(JSON.stringify(body["messages"]));
      const step = steps[Math.min(at++, steps.length - 1)]!;
      await step.before?.();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ role: "assistant", content: "" }, null));
      const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
      if (step.call !== undefined) { res.write(sse({ tool_calls: [{ index: 0, id: `call_${at}`, type: "function", function: { name: step.call.name, arguments: JSON.stringify(step.call.args) } }] }, null)); res.write(sse({}, "tool_calls", usage)); }
      else if (step.thinking !== undefined) { res.write(sse({ reasoning_content: step.thinking }, null)); res.write(sse({}, "stop", usage)); }
      else { res.write(sse({ content: `${step.text ?? "done"}` }, null)); res.write(sse({}, step.length === true ? "length" : "stop", usage)); }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen, bodies };
}

export async function rig(launcher: SandboxLauncher, steps: Step[], options: { /** The endpoint's kind (card W07: it names the budget's request fields). */ readonly kind?: string } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn w03 ")));
  const shared = join(directory, "shared");
  mkdirSync(join(shared, "src"), { recursive: true });
  sh(directory, "init", "-q", "-b", "main", shared);
  writeFileSync(join(shared, "src", "a.ts"), "export const a = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(directory, "git-scratch") });
  let local: LocalWorker | undefined;
  const ws = new LocalWorkspaces({ root: join(directory, "work"), git, shared: () => shared, busy: () => local?.busyAttempts() ?? [], landing: () => ({ branch: "main", requirePermit: false }) });
  const answer = await model(steps);
  const c = await startController({
    storage: { kind: "sqlite", path: join(directory, "c.sqlite") }, argv: [], env: {}, print: () => undefined,
    facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [PI],
    tools: { runner: { run: async () => { throw new Error("no script call runs in this test"); } } as never, isLocalHost: (hostId) => hostId === "host:w1", facts: async () => ({ os: "linux", arch: "x64", interpreters: { node: process.versions.node }, packages: {}, cpus: 8, memoryMb: 16_384 }) },
    dispatch: {
      manual: true,
      local: {
        window: () => 32768,
        build: (services) => {
          const relay = new ModelRelay({ fetch: loopbackFetch, endpoint: (route) => (route === "localp/small" ? { url: answer.url, headers: () => ({ authorization: "Bearer sk-provider-secret" }), ...(options.kind === undefined ? {} : { kind: options.kind }) } : undefined) });
          const parts = localWorkerParts<Pick<ToolGateway, "call">["call"]>({
            launcher, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
            workspace: async (order) => {
              const o = order as unknown as WorkOrder;
              const made = await ws.ensure({ taskId: o.taskId, projectId: o.projectId });
              const home = join(directory, "attempts", o.attemptId, "home"), scratch = join(directory, "attempts", o.attemptId, "scratch");
              mkdirSync(home, { recursive: true }); mkdirSync(scratch, { recursive: true });
              return { checkout: made.checkout, gitDir: made.gitDir, home, scratch };
            },
            model: () => ({ alias: "m0", provider: "localp", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] }),
            namespaceId: (order) => services.namespaceId(order as never),
            bridge: async (order, call, token, request) => services.bridge!(order as never, call, token, request) as never,
            relay: (order, request) => services.attemptRelay(order as never, relay, { model: "local" }).relay(request),
            context: (order) => services.context(order as never),
            heldForReview: (order) => c.dispatch!.dispatcher.heldForReview(order.attemptId),
            ...ownerPolicyOptions(services),
          });
          local = new LocalWorker({
            hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "w03-test", guards: services.guards, ownerPolicy: parts.ownerPolicy,
            schedule: (beat) => { const timer = setInterval(() => { void beat(); }, 100); return () => clearInterval(timer); },
            sandbox: parts.sandbox as never, runtimes: { open: (order, call, from) => parts.runtimes.open(order as never, call, from as never) as never },
            capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }) as never,
            // What the task's checkout holds, read by the worker package's checkout layout (card W03).
            progress: (scope) => ws.progress(scope),
            // The check of a done (card W05): the checkout's state from the same layout, and the contract's checks run in the attempt's sandbox.
            verify: doneVerifier({ workspaces: ws, checks: parts.checks }),
          });
          return local;
        },
      },
    },
  });
  assert.ok(c.dispatch !== undefined, c.dispatchProblem);
  const s = c.services;
  const owner = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
  await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" } } } as never);
  await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
  await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
  await local!.register(HostService.withEpoch(c.storage, c.epoch, s.assignments), await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token));
  await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
  await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
  const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
  await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: AGENT, grants: workGrants(project) });
  const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Fix the parser" })).id;
  await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
  await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: AGENT } });
  const a = (await s.assignments.getAssignment(taskId))!;
  const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
  return {
    c, owner, project, taskId, attemptId, ws, answer,
    run: async () => { await c.dispatch!.dispatcher.tick(); await c.dispatch!.dispatcher.idle(); },
    get: async () => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))!,
    close: async () => { answer.server.closeAllConnections(); answer.server.close(); await c.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); },
  };
}

export async function sandbox(t: { skip(why: string): void }): Promise<SandboxLauncher | undefined> {
  const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = hasGit && launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox or git is unusable: ${launcher.capacity.reason ?? "git is missing"}`);
    t.skip("bubblewrap, git or a node install it can mount is unusable");
  }
  return usable ? launcher : undefined;
}

