import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { WORKER_CHANNEL_VERSION } from "@nimblenewt/contracts";
import { AdmissionService, BlockerService, HostService, LocalWorker, startController, type WorkOrder } from "@nimblenewt/controller";
import { PI, workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher, localWorkerParts, ownerPolicyOptions, type WorkerApp } from "@nimblenewt/worker";

// Card A08d, end to end with the real sandbox: the limits of an agent's environment manifest, cut by the owner's limits for all agents, are given to each launch through the dispatch contract and really hold. A worker process
// (bubblewrap, composed by startController) allocates memory when its turn begins and writes a file when it has the memory. The agent whose environment allows 256 MB is killed by the system; so is one whose environment
// asks for 4 GB when the owner's limit is 1 GB (an environment cannot raise a limit); one that stays under the cut figure finishes. Each attempt's record says what was enforced and whose figure it was. With the owner
// requiring full enforcement (the default) a manifest limit this host cannot hold in full (the disk total) refuses the attempt with a blocker and nothing is started.
// Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms: number, why: string): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(why); await sleep(50); } };
const D = (c: string): string => `sha256:${c.repeat(64)}`;
const MB = 1024 * 1024;

test("the environment's memory limit, cut by the owner's, really holds on the launched process, and the attempt's record says what was enforced; a limit the host cannot hold in full refuses the launch unless the owner allowed best effort", { timeout: 240_000 }, async (t) => {
  const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${launcher.capacity.reason}`);
    return t.skip("bubblewrap or a node install it can mount is unusable");
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn a08d ")));
  // A worker process that speaks just enough of the channel: ready on start; on `run` it takes the memory named in the task text (megabytes), writes /scratch/done, and answers with a result.
  const appDir = join(directory, "app");
  mkdirSync(appDir);
  writeFileSync(join(appDir, "main.js"), `const fs = require("node:fs");
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(line); } catch { continue; }
  if (m.t === "start") send({ t: "ready", v: ${WORKER_CHANNEL_VERSION} });
  if (m.t === "checkpoint") send({ t: "checkpoint.ok", id: m.id, checkpoint: { at: "turn" } });
  if (m.t === "run") { const mb = Number((/take (\\d+) MB/.exec(m.content) || [])[1] || 1); const hold = Buffer.alloc(mb * 1024 * 1024, 7); fs.writeFileSync("/scratch/done", String(hold.length)); send({ t: "result", status: "completed", text: "done" }); }
  if (m.t === "close") process.exit(0);
} });
setInterval(() => undefined, 1000);
`);
  const app: WorkerApp = { node: { root: nodeRoot, executable: "bin/node" }, mounts: [{ host: appDir, guest: "/opt/app" }], entry: "/opt/app/main.js", hostEntry: join(appDir, "main.js") };
  const scratches = new Map<string, string>();
  let c: Awaited<ReturnType<typeof startController>> | undefined;
  let worker: LocalWorker | undefined;
  try {
    c = await startController({
      storage: { kind: "sqlite", path: join(directory, "c.sqlite") }, argv: [], env: {}, print: () => undefined,
      facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [PI],
      dispatch: {
        manual: true,
        route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
        local: {
          window: () => 32768,
          build: (services) => {
            const parts = localWorkerParts<unknown>({
              launcher, app, protectedPaths: [],
              workspace: (order) => {
                const o = order as unknown as WorkOrder;
                const base = join(directory, "attempts", o.attemptId);
                const dirs = { checkout: join(base, "checkout"), gitDir: join(base, "git"), home: join(base, "home"), scratch: join(base, "scratch") };
                for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
                scratches.set(o.attemptId, dirs.scratch);
                return dirs;
              },
              model: () => ({ alias: "m0", provider: "p", api: "openai-completions", modelId: "m", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] }),
              namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "unavailable", message: "no bridge here" }), relay: async () => { throw new Error("no model here"); },
              ...ownerPolicyOptions(services),
            });
            worker = new LocalWorker({
              hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "a08d-test",
              sandbox: parts.sandbox as never, runtimes: { open: (order: unknown, call: unknown, from: unknown) => parts.runtimes.open(order as never, call as never, from as never) as never },
              capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }) as never,
              ownerPolicy: parts.ownerPolicy,
            } as never);
            return worker;
          },
        },
      },
    });
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c!.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    await worker!.register(HostService.withEpoch(c.storage, c.epoch, s.assignments), await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token));
    const local = c.dispatch.dispatcher;
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;

    // The agent's environment: its limits as the manifest states them.
    const makeAgent = async (name: string, limits: Record<string, number>): Promise<string> => {
      const agent = `agt-${name}`;
      await s.principals.enroll(owner, { commandId: `e-${name}`, kind: "agent", name: agent, grants: workGrants(project) });
      const manifest = { base: { name: "nimblenewt-base", version: "1.0.0", digest: D("a") }, packages: [], skills: [], capabilities: [], configuration: { installation: 1 }, limits, protectedExtensions: [] };
      await s.environments.change(owner, { commandId: `ec-${name}`, agentId: `agent:${agent}`, manifest, reason: "test" });
      await s.environments.activate(owner, { commandId: `ea-${name}`, agentId: `agent:${agent}`, revision: 1, observed: {} });
      return agent;
    };
    let n = 0;
    const attempt = async (agent: string, mb: number): Promise<{ attemptId: string; taskId: string; started: boolean }> => {
      n++;
      const taskId = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title: `take ${mb} MB` })).id;
      await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
      await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId, owner: { kind: "agent", id: agent } });
      const a = (await s.assignments.getAssignment(taskId))!;
      const attemptId = (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
      const ticked = await local.tick();
      await local.idle();
      return { attemptId, taskId, started: ticked.started.includes(attemptId) };
    };
    const record = async (attemptId: string): Promise<any> => (await call("workers.limits.enforced", { attemptId })).result?.item?.launches?.at(-1);
    const finished = async (attemptId: string) => (await local.get(owner, attemptId))!.state === "finished";

    // The owner's limits for all agents: 1 GB of memory at most. Strict enforcement is the default.
    assert.ok((await call("workers.limits.change", { set: { memoryMb: 1024 } }, "lim1")).ok);

    // Strict (the default): every manifest states a disk total, which a worker cannot hold in full, so the launch is refused with a blocker, nothing runs and the refusal is on record with the figures and whose they are.
    const tight = await makeAgent("tightaaaaaaaaaaaaaaa", { cpus: 1, memoryMb: 256, diskMb: 1000, processes: 200 });
    const strict = await attempt(tight, 600);
    assert.equal(strict.started, false);
    await until(() => finished(strict.attemptId), 20_000, "the refused attempt ended");
    assert.equal(existsSync(join(scratches.get(strict.attemptId) ?? directory, "done")), false, "nothing ran");
    const refused = await record(strict.attemptId);
    assert.equal(refused.outcome, "refused", JSON.stringify(refused));
    assert.equal(refused.requested.memoryMb, 256);
    assert.ok(refused.failed.some((f: { limit: string }) => f.limit === "diskMb"), JSON.stringify(refused));
    assert.deepEqual(refused.environment.sources, { cpus: "environment", memoryMb: "environment", diskMb: "environment", processes: "environment" });
    const blocker = await BlockerService.withEpoch(c.storage, c.epoch).openFor("dispatch_blocked", { kind: "task", id: strict.taskId });
    assert.match(blocker?.summary ?? "", /could not be fully enforced|cannot be fully enforced|not be enforced/i, blocker?.summary);
    const attemptBody = (await local.get(owner, strict.attemptId))! as any;
    assert.equal(attemptBody.launchLimits.outcome, "refused");
    assert.equal(attemptBody.launchLimits.limits.memoryMb, 256);

    // Best effort allowed by the owner: the disk total is reported as partial, the memory limit is enforced, and the attempts run under their limits.
    assert.ok((await call("workers.limits.besteffort", { enabled: true }, "be1")).ok);
    const small = await attempt(tight, 600);
    assert.equal(small.started, true);
    await until(() => finished(small.attemptId), 60_000, "the over-memory attempt ended");
    assert.equal(existsSync(join(scratches.get(small.attemptId)!, "done")), false, "the process asked for 600 MB under a 256 MB limit and was ended by the system before it had them");
    const smallRecord = await record(small.attemptId);
    assert.equal(smallRecord.outcome, "started");
    assert.equal(smallRecord.requested.memoryMb, 256);
    const mem = smallRecord.enforcement.find((e: { limit: string }) => e.limit === "memoryMb");
    assert.ok(["full", "partial"].includes(mem.enforced), JSON.stringify(mem));
    assert.equal(smallRecord.enforcement.find((e: { limit: string }) => e.limit === "diskMb").enforced, "partial");
    const body = (await local.get(owner, small.attemptId))! as any;
    assert.equal(body.launchLimits.outcome, "started");
    assert.equal(body.launchLimits.bestEffort, true);
    assert.deepEqual(body.launchLimits.enforcement.map((e: { limit: string; enforced: string }) => e.limit).sort(), ["cpus", "diskMb", "memoryMb", "processes"]);

    // The same agent and limit with a process that stays under it: it has the memory it needs (the kill above was the limit, not a broken worker).
    const modest = await attempt(tight, 100);
    await until(() => existsSync(join(scratches.get(modest.attemptId) ?? directory, "done")), 60_000, "a process under its 256 MB limit had the memory it needed");

    // An environment that asks for 4 GB under the owner's 1 GB: cut to 1 GB (recorded), and a process that takes 1.5 GB is ended; one that takes 300 MB finishes.
    const greedy = await makeAgent("greedyaaaaaaaaaaaaaa", { cpus: 1, memoryMb: 4096, diskMb: 1000, processes: 200 });
    const over = await attempt(greedy, 1500);
    await until(() => finished(over.attemptId), 60_000, "the greedy attempt ended");
    assert.equal(existsSync(join(scratches.get(over.attemptId)!, "done")), false, "the environment could not raise the owner's 1 GB limit");
    const overRecord = await record(over.attemptId);
    assert.equal(overRecord.requested.memoryMb, 1024);
    assert.deepEqual(overRecord.environment.capped, [{ limit: "memoryMb", asked: 4096, applied: 1024 }]);
    assert.equal(overRecord.environment.sources.memoryMb, "installation");
    const fine = await attempt(greedy, 300);
    await until(() => existsSync(join(scratches.get(fine.attemptId) ?? directory, "done")), 60_000, "a process under its limit had the memory it needed");
    assert.equal(overRecord.environment.revision, 1);
  } finally {
    await c?.close();
    await launcher.stop();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
