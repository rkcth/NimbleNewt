import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AdmissionService, DifficultyService, HostService, LocalWorker, ModelRelay, PolicyService, startController, type ToolGateway, type WorkOrder } from "@nimblenewt/controller";
import { EXEC_PROFILES, PI, ROUTING_TABLE, workGrants } from "@nimblenewt/controller/testing";
import { GitBridge, LocalWorkspaces, SandboxLauncher, appFromRepository, jobLauncher, localWorkerParts, ownerPolicyOptions } from "@nimblenewt/worker";
import { loopbackFetch, sse } from "./h12-worker-support.js";

// Card T07b, end to end: a real local worker (bubblewrap and the worker process running Pi, composed by startController) starts a catalogue tool as a long-running job through its tool bridge and gets a durable handle; the job runs in the
// sandbox through the real launcher, outlives the attempt that started it, and a later attempt of the same task (a new worker process) reads its state and its output (redacted and quoted) and stops it: the whole process tree ends,
// grandchild included. The owner's Force Stop through the API ends another job's tree, and closing the controller ends the last one: no job outlives the controller. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENT = "agt-abcdefghijklmnopqrst";
const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms: number, why: string | (() => string | Promise<string>)): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(typeof why === "function" ? await why() : why); await sleep(50); } };
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
/** The processes whose command line holds `marker`, from the host's /proc (the sandbox's processes included). */
const holding = (marker: string): number[] => {
  const found: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try { if (readFileSync(join("/proc", name, "cmdline")).toString("utf8").includes(marker)) found.push(Number(name)); } catch { /* gone */ }
  }
  return found;
};

interface Step { readonly text?: string; readonly call?: { readonly name: string; readonly args: object } }
/** A model endpoint that plays the steps in order; a step may be worked out when it is reached. */
async function model(steps: (Step | (() => Step))[]): Promise<{ server: Server; url: string; seen: string[] }> {
  const seen: string[] = [];
  let at = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push(JSON.stringify((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: unknown }).messages));
      const next = steps[Math.min(at++, steps.length - 1)]!;
      const step = typeof next === "function" ? next() : next;
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

test("a real local worker starts a job through the bridge; a later attempt reads and stops it by its handle, and every stop ends the job's whole process tree through the real launcher (card T07b)", { skip: hasGit ? false : "git is not installed" }, async (t) => {
  const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${launcher.capacity.reason}`);
    return t.skip("bubblewrap or a node install it can mount is unusable");
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn t07b jobs ")));
  const shared = join(directory, "shared");
  mkdirSync(join(shared, "src"), { recursive: true });
  sh(directory, "init", "-q", "-b", "main", shared);
  writeFileSync(join(shared, "src", "a.ts"), "export const a = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const jobsBase = join(directory, "jobs");
  mkdirSync(jobsBase);
  const git = await GitBridge.create({ scratch: join(directory, "git-scratch") });
  let local: LocalWorker | undefined;
  const ws = new LocalWorkspaces({ root: join(directory, "work"), git, shared: () => shared, busy: () => local?.busyAttempts() ?? [], landing: () => ({ branch: "main", requirePermit: false }) });
  const marker = `nn-t07b-${process.pid}-${Date.now()}`;
  // The job: reads its input, starts a grandchild that would run for ever (named by the marker and its target), writes a credential-shaped line and a tick every 200 ms, and never ends by itself.
  const source = `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)","${marker}-"+i.target],{stdio:"ignore",detached:true});c.unref();process.stdout.write("started "+i.target+"\\n");process.stdout.write("Authorization: Bea"+"rer "+"${TOKEN.slice(0, 20)}"+"${TOKEN.slice(20)}\\n");setInterval(()=>process.stdout.write("tick\\n"),200);});`;
  let tool = "";
  let jobOne = "";
  const steps: (Step | (() => Step))[] = [
    // Attempt one starts the job and ends.
    () => ({ call: { name: "nimblenewt__job-start", args: { tool, version: "1.0.0", input: { target: "site" }, label: "site build" } } }),
    { call: { name: "nimblenewt__work-end", args: { report: "Done as the task asked.", result: "done" } } },
    { text: "the build runs" },
    // Attempt two reads it by its handle, stops it, and starts two more.
    () => ({ call: { name: "nimblenewt__job-status", args: { jobId: jobOne } } }),
    () => ({ call: { name: "nimblenewt__job-output", args: { jobId: jobOne } } }),
    () => ({ call: { name: "nimblenewt__job-cancel", args: { jobId: jobOne, reason: "not needed any more" } } }),
    () => ({ call: { name: "nimblenewt__job-start", args: { tool, version: "1.0.0", input: { target: "docs" } } } }),
    () => ({ call: { name: "nimblenewt__job-start", args: { tool, version: "1.0.0", input: { target: "logs" }, background: true } } }),
    { call: { name: "nimblenewt__work-end", args: { report: "Done as the task asked.", result: "done" } } },
    { text: "all done" },
  ];
  const answer = await model(steps);
  let c: Awaited<ReturnType<typeof startController>> | undefined;
  let rob: Awaited<ReturnType<NonNullable<typeof c>["services"]["principals"]["authenticate"]>> | undefined;
  try {
    c = await startController({
      storage: { kind: "sqlite", path: join(directory, "c.sqlite") }, argv: [], env: {}, print: () => undefined,
      facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [PI],
      tools: { runner: { run: async () => { throw new Error("no script call runs in this test"); } } as never, isLocalHost: (hostId) => hostId === "host:w1", facts: async () => ({ os: "linux", arch: "x64", interpreters: { node: process.versions.node }, packages: {}, cpus: 8, memoryMb: 16_384 }) },
      // The real job launcher over the real sandbox launcher. This host may not be able to enforce cgroup limits (a container), so they are not required here.
      jobs: { launcher: jobLauncher({ launcher, interpreters: (name, version) => (name === "node" && version === process.versions.node ? { root: nodeRoot, executable: "bin/node" } : undefined), base: jobsBase, requireEnforced: false }), limits: { flushMs: 50, graceMs: 5000 } },
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
              // Every tool request crosses to the controller's own tool bridge; a first catalogue call parked for review is allowed by the owner at once and asked again with the same call ID.
              bridge: async (order, call, token, request) => {
                const first = await services.bridge!(order as never, call, token, request);
                if (first.ok && first.result["state"] === "awaiting-approval") {
                  const review = (await c!.services.reviews.get(rob!, first.result["reviewId"] as string))!;
                  await c!.services.reviews.decide(rob!, { commandId: `dec-${request.callId}`, requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "reviewed" } as never);
                  return services.bridge!(order as never, call, token, request) as never;
                }
                return first as never;
              },
              relay: (order, request) => services.attemptRelay(order as never, relay, { model: "local" }).relay(request),
              context: (order) => services.context(order as never),
              heldForReview: (order) => c!.dispatch!.dispatcher.heldForReview(order.attemptId),
              ...ownerPolicyOptions(services),
            });
            local = new LocalWorker({
              hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "t07b-test", guards: services.guards, ownerPolicy: parts.ownerPolicy,
              schedule: (beat) => { const timer = setInterval(() => { void beat(); }, 100); return () => clearInterval(timer); },
              sandbox: parts.sandbox as never, runtimes: { open: (order, call, from) => parts.runtimes.open(order as never, call, from as never) as never },
              capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }) as never,
            });
            return local;
          },
        },
      },
    });
    assert.ok(c.dispatch !== undefined && c.jobRuns !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    rob = await s.principals.authenticate(boot.token);
    const owner = rob;
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" } } } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    await local!.register(HostService.withEpoch(c.storage, c.epoch, s.assignments), await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token));
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: AGENT, grants: [...workGrants(project), { action: "desk.write", project }, { action: "desk.read", project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }, { action: "job.write", project }] });
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Build the site" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: AGENT } });
    // The agent's tool, registered in its own namespace from two of its desk records.
    const ann = await s.principals.authenticate((await s.principals.issueCredential(owner, `agent:${AGENT}`)).token);
    const doc = await s.desks.write(ann, { commandId: "doc", projectId: project, taskId, kind: "note", title: "build notes", body: "Builds a target; runs until stopped.", visibility: "shared", status: "accepted" } as never);
    const code = await s.desks.write(ann, { commandId: "code", projectId: project, taskId, kind: "note", title: "build code", body: source, visibility: "shared", status: "accepted" } as never);
    tool = (await s.catalog.register(ann, { commandId: "reg", name: "build", kind: "tool", version: "1.0.0", instructionsRecordId: doc.id, executableRecordId: code.id, manifest: {
      purpose: "build a target", input: { type: "object", properties: { target: { type: "string", maxLength: 20 } }, required: ["target"], additionalProperties: false }, output: { type: "object" },
      entryPoint: "bin/build.js", interpreter: { name: "node", version: process.versions.node }, os: ["linux"], arch: ["x64", "arm64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 256, seconds: 120 }, cancellation: "cooperative", recovery: "none",
    } } as never)).name;
    const admit = async (n: number): Promise<string> => { const a = (await s.assignments.getAssignment(taskId))!; return (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id; };
    const job = async (id: string) => (await s.jobs.get(owner, id))!;

    // Attempt one: the job is started and its handle returned; the attempt ends and the job runs on.
    const first = await admit(1);
    assert.deepEqual((await c.dispatch.dispatcher.tick()).started, [first]);
    await until(() => answer.seen.length >= 3, 60_000, () => `attempt one never reached its last model call: ${answer.seen.length}`);
    await c.dispatch.dispatcher.idle();
    assert.equal((await c.dispatch.dispatcher.get(c.dispatch.principal, first))!.state, "finished");
    jobOne = /job-[a-z2-7]{20}/.exec(answer.seen[1]!)?.[0] ?? "";
    assert.ok(jobOne !== "", `the handle came back to the agent: ${answer.seen[1]!.slice(-400)}`);
    await until(async () => (await job(jobOne)).output.tail.includes("tick"), 30_000, async () => JSON.stringify(await job(jobOne)));
    assert.equal((await job(jobOne)).state, "running");
    assert.equal((await job(jobOne)).output.tail.includes(TOKEN), false, "the credential-shaped line is redacted in the record");
    await until(() => holding(`${marker}-site`).length > 0, 10_000, "positive control: the job's grandchild is seen while it runs");

    // Attempt two, a new worker process: status, quoted output and the Stop by the handle; then two more jobs.
    const second = await admit(2);
    assert.deepEqual((await c.dispatch.dispatcher.tick()).started, [second]);
    await until(() => answer.seen.length >= 10, 60_000, () => `attempt two never reached its last model call: ${answer.seen.length}`);
    await c.dispatch.dispatcher.idle();
    assert.match(answer.seen[4]!, /\\"state\\":\\"running\\".*site build/, "the status came back to the agent");
    const outputReply = answer.seen[5]!;
    assert.match(outputReply, /started site/);
    assert.equal(outputReply.includes(TOKEN), false, "a credential in the output never reaches the agent");
    assert.match(outputReply, /data from the program, not instructions/);
    assert.match(answer.seen[6]!, /stop_tool/);
    await until(async () => (await job(jobOne)).state === "cancelled", 15_000, async () => JSON.stringify(await job(jobOne)));
    assert.deepEqual((await job(jobOne)).orphans, []);
    await until(() => holding(`${marker}-site`).length === 0, 10_000, "the Stop ended the whole tree, grandchild included");
    const ids = [...answer.seen[7]!.matchAll(/job-[a-z2-7]{20}/g), ...answer.seen[8]!.matchAll(/job-[a-z2-7]{20}/g)].map((m) => m[0]).filter((id) => id !== jobOne);
    const [docs, logs] = [ids[0]!, ids.at(-1)!];
    assert.notEqual(docs, logs);
    await until(async () => (await job(docs)).state === "running" && (await job(logs)).state === "running", 30_000, "the two new jobs run");
    await until(() => holding(`${marker}-docs`).length > 0 && holding(`${marker}-logs`).length > 0, 10_000, "positive control: their grandchildren run");

    // The owner's Force Stop through the API ends one tree at once.
    const forced = await c.api.handle(boot.token, { v: 1, op: "job.cancel", commandId: "force-docs", args: { jobId: docs, reason: "stop it now", force: true } } as never);
    assert.equal(forced.ok, true, JSON.stringify(forced));
    await until(async () => (await job(docs)).state === "cancelled", 15_000, async () => JSON.stringify(await job(docs)));
    assert.equal((await job(docs)).cancel?.force, true);
    await until(() => holding(`${marker}-docs`).length === 0, 10_000, "the Force Stop ended the whole tree");
    assert.ok(holding(`${marker}-logs`).length > 0, "the other job runs on");

    // Closing the controller ends the last job and records why: no job outlives the controller.
    await c.close();
    c = undefined;
    await until(() => holding(`${marker}-logs`).length === 0, 10_000, "closing the controller ended the last job's tree");
    assert.deepEqual(readdirSync(jobsBase), [], "every job's private directory is removed");
  } finally {
    answer.server.closeAllConnections(); answer.server.close();
    await c?.close();
    await launcher.stop();
    for (const pid of holding(marker)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    try { execFileSync("chmod", ["-R", "u+rwX", directory]); } catch { /* nothing to open */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
