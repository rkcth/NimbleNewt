import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AdmissionService, DifficultyService, HostService, LocalWorker, ModelRelay, PolicyService, startController, type ToolGateway, type WorkOrder } from "@nimblenewt/controller";
import { EXEC_PROFILES, PI, ROUTING_TABLE, workGrants } from "@nimblenewt/controller/testing";
import { GitBridge, LocalWorkspaces, SandboxLauncher, appFromRepository, jobLauncher, localWorkerParts, ownerPolicyOptions } from "@nimblenewt/worker";
import { loopbackFetch, sse } from "./h12-worker-support.js";
import { PI_AGENT_LAYOUT, sharedSystemText } from "@nimblenewt/pi-adapter";
import { JOB_WAKE_RULE } from "@nimblenewt/controller";

// Card W11, end to end: a real local worker (bubblewrap and the worker process running Pi, composed by startController) starts a catalogue tool as a long-running job through its tool bridge, is told in the reply that the task is woken
// when the job ends, and ends its turn without work.end. The turn is not nudged on (a job of the task runs), the attempt parks for the job, the job runs to its end through the real job launcher, and the next tick readmits the same
// attempt in a new worker process: its model request carries the earlier turn and the wake note naming the job, and the agent reads the output and ends with work.end. One wake, one Notice for the owner, and the owner's jobs view says
// how the job ended. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENT = "agt-abcdefghijklmnopqrst";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms: number, why: string | (() => string | Promise<string>)): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(typeof why === "function" ? await why() : why); await sleep(50); } };
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

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

test("an agent that starts a job and ends its turn is woken once in the same conversation when the job ends, reads its output and finishes; the owner is told once (card W11)", { skip: hasGit ? false : "git is not installed" }, async (t) => {
  const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${launcher.capacity.reason}`);
    return t.skip("bubblewrap or a node install it can mount is unusable");
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn w11 wake ")));
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
  // The job: reads its input, waits a moment (the agent's turn ends meanwhile), writes one line and exits 0.
  const source = `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);setTimeout(()=>{process.stdout.write("built "+i.target+" in 3 pages\\n");process.exit(0);},5000);});`;
  let tool = "";
  let jobOne = "";
  const steps: (Step | (() => Step))[] = [
    // Run one: start the job, then end the turn in prose, as the reply says it may.
    () => ({ call: { name: "nimblenewt__job-start", args: { tool, version: "1.0.0", input: { target: "site" }, label: "site build" } } }),
    { text: "The site build runs; I noted my place and will read it when this task is woken." },
    // Run two, after the wake: read the output, end the work.
    () => ({ call: { name: "nimblenewt__job-output", args: { jobId: jobOne } } }),
    { call: { name: "nimblenewt__work-end", args: { result: "done", note: "the site is built" } } },
    { text: "Done: the site is built." },
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
              hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "w11-test", guards: services.guards, ownerPolicy: parts.ownerPolicy,
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

    // Run one: the job is started, the reply says what the agent can rely on, the turn ends in prose and is not nudged on (a job of the task runs): the attempt parks for the job.
    const attempt = await admit(1);
    assert.deepEqual((await c.dispatch.dispatcher.tick()).started, [attempt]);
    await until(() => answer.seen.length >= 2, 60_000, () => `run one never reached its second model call: ${answer.seen.length}`);
    await c.dispatch.dispatcher.idle();
    jobOne = /job-[a-z2-7]{20}/.exec(answer.seen[1]!)?.[0] ?? "";
    assert.ok(jobOne !== "", `the handle came back to the agent: ${answer.seen[1]!.slice(-400)}`);
    assert.match(answer.seen[1]!, /this task is woken once to read it/, "the job-start reply says what the agent can rely on");
    let d = (await c.dispatch.dispatcher.get(c.dispatch.principal, attempt))!;
    assert.equal(answer.seen.length, 2, "no nudge while the job runs (W04 asks the controller, which refuses)");
    assert.equal(d.state, "parked", JSON.stringify(d.outcome));
    assert.deepEqual(d.waitsOnJobs, [jobOne]);
    assert.equal(d.turnEnd?.endKind, "no-work-end");
    assert.equal(d.stoppedEarly, undefined, "not counted as a stop before the work was done");

    // Nothing starts while the job runs; the job ends by itself.
    await c.dispatch.dispatcher.tick();
    assert.equal(answer.seen.length, 2);
    await until(async () => (await job(jobOne)).state === "completed", 30_000, async () => JSON.stringify(await job(jobOne)));

    // The next tick wakes the same attempt in a new worker process, in the same conversation, with the wake note.
    const report = await c.dispatch.dispatcher.tick();
    assert.deepEqual(report.woken, [attempt]);
    await until(() => answer.seen.length >= 5, 60_000, () => `run two never reached its last model call: ${answer.seen.length}`);
    await c.dispatch.dispatcher.idle();
    const woken = answer.seen[2]!;
    assert.match(woken, /The site build runs; I noted my place/, "the same conversation: the earlier turn is there");
    assert.match(woken, new RegExp(`this task was woken for it: the job \\\\"site build\\\\" \\(${jobOne}\\) completed`), woken.slice(-1200));
    assert.match(answer.seen[3]!, /built site in 3 pages/, "the agent read the output");
    d = (await c.dispatch.dispatcher.get(c.dispatch.principal, attempt))!;
    assert.equal(d.state, "finished");
    assert.equal(d.outcome?.status, "succeeded", d.outcome?.summary);
    assert.equal(d.wakeRound, 1);

    // One wake: more ticks start nothing; the owner was told once, as a Notice, in plain words.
    await c.dispatch.dispatcher.tick();
    await c.dispatch.dispatcher.idle();
    assert.equal(answer.seen.length, 5);
    // Card W06: every call of both processes (the first attempt's run and the woken one) has the completion rules as its one system message, the same bytes, with JOB_WAKE_RULE in them.
    for (const [i, raw] of answer.seen.entries()) {
      const messages = JSON.parse(raw) as { role: string; content: unknown }[];
      const system = messages.filter((m) => m.role === "system" || m.role === "developer");
      assert.equal(system.length, 1, `call ${i + 1}: one system message`);
      const text = typeof system[0]!.content === "string" ? system[0]!.content : (system[0]!.content as { text: string }[]).map((b) => b.text).join("");
      assert.equal(text, sharedSystemText(PI_AGENT_LAYOUT), `call ${i + 1} carries exactly the completion rules`);
      assert.ok(text.includes(JOB_WAKE_RULE));
    }
    const items = (await c.storage.listAggregates("notification-item", { limit: 1000 })).map((a) => a.body as unknown as { ref: { kind: string; id: string }; level?: string; label: string; detail?: string; count: number }).filter((i) => i.ref.kind === "job");
    assert.equal(items.length, 1);
    assert.equal(items[0]!.count, 1);
    assert.equal(items[0]!.level, "notice");
    assert.match(items[0]!.label, /^Job "site build" completed$/);
    assert.match(items[0]!.detail ?? "", /The agent was woken to read it\./);
    assert.deepEqual(readdirSync(jobsBase), [], "the job's private directory is removed");
  } finally {
    answer.server.closeAllConnections(); answer.server.close();
    await c?.close();
    await launcher.stop();
    try { execFileSync("chmod", ["-R", "u+rwX", directory]); } catch { /* nothing to open */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
