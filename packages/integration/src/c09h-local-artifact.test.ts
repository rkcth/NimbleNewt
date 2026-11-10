import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AdmissionService, DifficultyService, HostService, LocalWorker, ModelRelay, PolicyService, startController, type ToolGateway, type WorkOrder } from "@nimblenewt/controller";
import { EXEC_PROFILES, PI, ROUTING_TABLE, workGrants } from "@nimblenewt/controller/testing";
import { GitBridge, LocalWorkspaces, SandboxLauncher, appFromRepository, localWorkerParts, ownerPolicyOptions } from "@nimblenewt/worker";
import { loopbackFetch, sse } from "./h12-worker-support.js";

// Card C09h, end to end: a real local worker (the bubblewrap launcher and the worker process running Pi, composed by startController) publishes its output, a note that is not code, through its tool bridge.
// The artifact is recorded for the attempt's own task and every step of the run is in the task's activity record: the route, the harness, the artifact (citing it and naming the agent) the message the agent sent and the desk record it wrote.
// The owner reads the record in the activity view the chat asks for. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI), where it fails instead.
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENT = "agt-abcdefghijklmnopqrst";
const BEN = "agt-bcdefghijklmnopqrstu";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms: number, why: string | (() => string)): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(typeof why === "function" ? why() : why); await sleep(50); } };
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

interface Step { readonly text?: string; readonly call?: { readonly name: string; readonly args: object } }
/** A model endpoint that plays the steps in order. */
async function model(steps: Step[]): Promise<{ server: Server; url: string; seen: string[] }> {
  const seen: string[] = [];
  let at = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push(JSON.stringify((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: unknown }).messages));
      const step = steps[Math.min(at++, steps.length - 1)]!;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ role: "assistant", content: "" }, null));
      const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
      if (step.call !== undefined) { res.write(sse({ tool_calls: [{ index: 0, id: `call_${at}`, type: "function", function: { name: step.call.name, arguments: JSON.stringify(step.call.args) } }] }, null)); res.write(sse({}, "tool_calls", usage)); }
      else { res.write(sse({ content: step.text ?? "done" }, null)); res.write(sse({}, "stop", usage)); }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen };
}

test("a real local worker publishes its output through the tool bridge, and every step of the run, the artifact among them, is in the task's activity record (card C09h)", { skip: hasGit ? false : "git is not installed" }, async (t) => {
  const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${launcher.capacity.reason}`);
    return t.skip("bubblewrap or a node install it can mount is unusable (the macOS and Windows runs are card H12r)");
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn c09h artifact ")));
  const shared = join(directory, "shared");
  mkdirSync(join(shared, "src"), { recursive: true });
  sh(directory, "init", "-q", "-b", "main", shared);
  writeFileSync(join(shared, "src", "a.ts"), "export const a = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(directory, "git-scratch") });
  let local: LocalWorker | undefined;
  const ws = new LocalWorkspaces({ root: join(directory, "work"), git, shared: () => shared, busy: () => local?.busyAttempts() ?? [], landing: () => ({ branch: "main", requirePermit: false }) });
  const files = [{ path: "notes/seed-plan.md", text: "# Seed plan\nOrder tomato seeds by March." }, { path: "notes/list.txt", text: "tomato\nbasil" }];
  const answer = await model([
    // A task ID in the request is not accepted (the declared tool has none, and the bridge takes the task from the attempt).
    { call: { name: "nimblenewt__artifact-publish", args: { name: "Seed plan", files, taskId: "task-aaaaaaaaaaaaaaaaaaaa" } } },
    { call: { name: "nimblenewt__artifact-publish", args: { name: "Seed plan", files } } },
    { call: { name: "nimblenewt__message-send", args: { to: `agent:${BEN}`, class: "informational", purpose: "handover", text: "The seed plan is published." } } },
    { call: { name: "nimblenewt__desk-write", args: { kind: "note", title: "next", body: "Water on Fridays.", visibility: "shared", status: "accepted" } } },
    { call: { name: "nimblenewt__work-end", args: { result: "done", note: "seed plan published" } } },
    { text: "all done" },
  ]);
  let c: Awaited<ReturnType<typeof startController>> | undefined;
  try {
    c = await startController({
      storage: { kind: "sqlite", path: join(directory, "c.sqlite") }, argv: [], env: {}, print: () => undefined,
      facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [PI],
      artifacts: { directory: join(directory, "blobs") },
      tools: { runner: { run: async () => { throw new Error("no script runs in this test"); } } as never, isLocalHost: (hostId) => hostId === "host:w1" },
      dispatch: {
        manual: true,
        local: {
          window: () => 32768,
          build: (services) => {
            const relay = new ModelRelay({ fetch: loopbackFetch, endpoint: (route) => (route === "localp/small" ? { url: answer.url, headers: () => ({ authorization: "Bearer sk-provider-secret" }) } : undefined) });
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
              // Every tool request crosses to the controller's own tool bridge (ToolExecutionService), as the composer hands it to the host builder.
              bridge: async (order, call, token, request) => services.bridge!(order as never, call, token, request) as never,
              relay: (order, request) => services.attemptRelay(order as never, relay, { model: "local" }).relay(request),
              context: (order) => services.context(order as never),
              heldForReview: (order) => c!.dispatch!.dispatcher.heldForReview(order.attemptId),
              ...ownerPolicyOptions(services),
            });
            local = new LocalWorker({
              hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "c09h-test", guards: services.guards, ownerPolicy: parts.ownerPolicy,
              schedule: (beat) => { const timer = setInterval(() => { void beat(); }, 100); return () => clearInterval(timer); },
              sandbox: parts.sandbox as never, runtimes: { open: (order, call, from) => parts.runtimes.open(order as never, call, from as never) as never },
              capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }) as never,
            });
            return local;
          },
        },
      },
    });
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
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
    await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: AGENT, grants: [...workGrants(project), { action: "artifact.publish", project }, { action: "message.send", project }, { action: "desk.write", project }] });
    await s.principals.enroll(owner, { commandId: "e-ben", kind: "agent", name: BEN, grants: [{ action: "task.read", project }, { action: "message.receive", project }] });
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Plan the seed order" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;

    assert.deepEqual((await c.dispatch.dispatcher.tick()).started, [attemptId]);
    await until(() => answer.seen.length >= 5, 60_000, () => `the run never reached its last model call: ${answer.seen.length} call(s)`);
    await c.dispatch.dispatcher.idle();
    assert.equal((await c.dispatch.dispatcher.get(c.dispatch.principal, attemptId))!.state, "finished");
    assert.match(answer.seen[1]!, /taskId: schema is false/, "the request naming a task of its own was refused (the declared tool takes no task), and the refusal reached the agent");
    const artifactId = /art-[a-z2-7]+/.exec(answer.seen[2]!)?.[0];
    assert.ok(artifactId !== undefined, `the artifact's ID came back to the agent: ${answer.seen[2]!.slice(-400)}`);

    // The artifact is the attempt's task's, published by the agent, with its files.
    const listed = await c.api.handle(boot.token, { v: 1, op: "deliverable.list", args: { taskId } } as never) as unknown as { ok: boolean; result: { items: { id: string; files: { path: string }[] }[] } };
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.deepEqual(listed.result.items.map((i) => [i.id, i.files.map((f) => f.path)]), [[artifactId, ["notes/list.txt", "notes/seed-plan.md"]]]);

    // Every step of the run is in the activity record, in order: the route, the harness and the artifact (citing it, naming the agent).
    const read = await c.api.handle(boot.token, { v: 1, op: "activity.steps", args: { taskId } } as never) as unknown as { ok: boolean; result: { steps: { seq: number; kind: string; summary: string; manifest: { refs: { kind: string; id: string }[] } }[] } };
    assert.equal(read.ok, true, JSON.stringify(read));
    const steps = read.result.steps;
    assert.deepEqual(steps.map((x) => x.kind), ["model-selected", "harness-selected", "artifact-version", "agent-message", "tool-call"], `${JSON.stringify(steps.map((x) => [x.kind, x.summary]))} | ${answer.seen[3]!.slice(-300)}`);
    assert.match(steps[3]!.summary, new RegExp(`agent:${AGENT} sent agent:${BEN} a informational message: handover`), "the agent's message through the bridge is a step too");
    const record = /dsk-[a-z2-7]{20}/.exec(answer.seen[4]!)?.[0];
    assert.equal(steps[4]!.summary, `agent:${AGENT} wrote desk record ${record} through the bridge.`, "a desk record written through the bridge is a step too");
    assert.deepEqual(steps[4]!.manifest.refs, [{ kind: "desk-record", id: record }]);
    const art = steps[2]!;
    assert.equal(art.summary, `agent:${AGENT} published artifact "Seed plan" (2 files).`);
    assert.deepEqual(art.manifest.refs, [{ kind: "artifact", id: artifactId }]);
    // The owner reads it in the activity view the chat asks for.
    const view = await c.api.handle(boot.token, { v: 1, op: "status.ask", args: { request: { kind: "activity", taskId } } } as never) as unknown as { ok: boolean; result: { item: { lines: { text: string }[] } } };
    assert.equal(view.ok, true, JSON.stringify(view));
    assert.match(view.result.item.lines.map((l) => l.text).join("\n"), new RegExp(`artifact-version.*published artifact \\\\"Seed plan\\\\" \\(2 files\\)`));
  } finally {
    answer.server.closeAllConnections(); answer.server.close();
    await c?.close();
    await launcher.stop();
    try { execFileSync("chmod", ["-R", "u+rwX", directory]); } catch { /* nothing to open */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
