import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { WORKER_CHANNEL_VERSION } from "@nimblenewt/contracts";
import { AdmissionService, HostService, LocalWorker, startController, type WorkOrder } from "@nimblenewt/controller";
import { PI, workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher, localWorkerParts, PROCESS_LIMITS, type WorkerApp } from "@nimblenewt/worker";

// Card L02d, end to end with the real sandbox: a local worker (bubblewrap, composed by startController) runs a worker process that starts a detached process of its own and ignores the request to end. The stop's look lists
// the process it started (from the host's /proc), not the worker process itself while it runs; the Stop's ending asks the worker to end, kills it after the grace, and everything is gone; the time it took is charged to the
// task's budget as the cleanup's compute, once. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const AGENT = "agt-lzerotwodprocessesab";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms: number, why: string | (() => string | Promise<string>)): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(typeof why === "function" ? await why() : why); await sleep(50); } };
/** The processes whose command line holds `marker`, from the host's /proc (the sandbox's processes included). */
const holding = (marker: string): number[] => {
  const found: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try { if (readFileSync(join("/proc", name, "cmdline")).toString("utf8").includes(marker)) found.push(Number(name)); } catch { /* gone */ }
  }
  return found;
};

/** What the kernel calls a process. The listing shows this name, never the executable's file name: a process
 * started from `process.execPath` is "node" on some runners and "MainThread" on others (Node 24 names the main
 * thread that), so an expectation of a real process's name is read from /proc rather than written out. */
const commOf = (pid: number): string => readFileSync(`/proc/${String(pid)}/comm`, "utf8").trim();

test("a real worker process that ignores the request to end: its own process is listed, the Stop kills the whole sandbox after the grace, and winding it down is charged once as the cleanup's compute (card L02d)", { timeout: 120_000 }, async (t) => {
  const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${launcher.capacity.reason}`);
    return t.skip("bubblewrap or a node install it can mount is unusable");
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn l02d ")));
  const marker = `nn-l02d-${process.pid}-${Date.now()}`;
  // A worker process that speaks just enough of the channel: it says it is ready, answers a checkpoint, starts a detached process when its turn begins, and ignores the request to close and the end of its input.
  const appDir = join(directory, "app");
  mkdirSync(appDir);
  writeFileSync(join(appDir, "main.js"), `const { spawn } = require("node:child_process");
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(line); } catch { continue; }
  if (m.t === "start") send({ t: "ready", v: ${WORKER_CHANNEL_VERSION} });
  if (m.t === "checkpoint") send({ t: "checkpoint.ok", id: m.id, checkpoint: { at: "turn" } });
  if (m.t === "run") { const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "${marker}"], { stdio: "ignore", detached: true }); c.unref(); }
} });
process.stdin.on("end", () => undefined);
process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 1000);
`);
  const app: WorkerApp = { node: { root: nodeRoot, executable: "bin/node" }, mounts: [{ host: appDir, guest: "/opt/app" }], entry: "/opt/app/main.js", hostEntry: join(appDir, "main.js") };
  let c: Awaited<ReturnType<typeof startController>> | undefined;
  let local: LocalWorker | undefined;
  try {
    c = await startController({
      storage: { kind: "sqlite", path: join(directory, "c.sqlite") }, argv: [], env: {}, print: () => undefined,
      facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [PI],
      dispatch: {
        manual: true,
        route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
        local: {
          acceptUnenforcedLimits: true, window: () => 32768,
          build: () => {
            const parts = localWorkerParts<unknown>({
              launcher, app, protectedPaths: [], requireEnforced: false,
              workspace: (order) => {
                const o = order as unknown as WorkOrder;
                const base = join(directory, "attempts", o.attemptId);
                const dirs = { checkout: join(base, "checkout"), gitDir: join(base, "git"), home: join(base, "home"), scratch: join(base, "scratch") };
                for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
                return dirs;
              },
              model: () => ({ alias: "m0", provider: "p", api: "openai-completions", modelId: "m", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] }),
              namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "unavailable", message: "no bridge here" }), relay: async () => { throw new Error("no model here"); },
            });
            local = new LocalWorker({
              hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "l02d-test",
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
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c!.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    await local!.register(HostService.withEpoch(c.storage, c.epoch, s.assignments), await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token));
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: AGENT, grants: workGrants(project) });
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Water the beds" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: AGENT } });
    // A budget with no compute limit (0 = unlimited): the cleanup's compute is still recorded against it.
    assert.ok((await call("budget.open", { taskId, currency: "USD", costMicros: 5_000_000 }, "b1")).ok);
    const a = (await s.assignments.getAssignment(taskId))!;
    const attempt = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
    const ticked = await c.dispatch.dispatcher.tick();
    assert.deepEqual(ticked.started, [attempt], JSON.stringify(ticked));
    await until(() => holding(marker).length > 0, 30_000, "the worker process started its own process in the sandbox");
    const child = holding(marker)[0]!;

    // While the attempt runs, the look lists the process the worker started (by its ID and name, read from /proc) and not the worker process itself (that is the attempt, quiesced through it).
    const ready = await call("lifecycle.readiness", { scope: { kind: "task", id: taskId } });
    assert.ok(ready.ok, JSON.stringify(ready));
    const items = ready.result.unsettled as { kind: string; ref: string; state: string }[];
    assert.ok(items.some((i) => i.kind === "process" && i.ref === `pid ${child} ${JSON.stringify(commOf(child))}` && i.state === "running"), JSON.stringify(items));
    assert.equal(items.some((i) => /^worker process/.test(i.ref)), false, `the worker process itself is not waited on while it runs: ${JSON.stringify(items)}`);
    assert.ok((await local!.busyAttempts()).includes(attempt), "a process the agent started keeps the attempt busy for a workspace operation");

    // The Stop: the worker is asked to end, ignores it, is killed with its sandbox after the grace, and nothing of it is left.
    const started = Date.now();
    const stop = await call("lifecycle.stop", { scope: { kind: "task", id: taskId }, mode: "stop", reason: "night" }, "st1");
    assert.ok(stop.ok, JSON.stringify(stop));
    assert.equal(stop.result.outcome?.state, "stopped", JSON.stringify(stop.result));
    assert.ok(Date.now() - started >= PROCESS_LIMITS.closeGraceMs, "the worker was given the grace before it was killed");
    await until(() => holding(marker).length === 0, 10_000, "the process the worker started ended with the sandbox");
    assert.deepEqual((await local!.localWork([attempt])).processes, [], "nothing is held any more");
    // What winding the worker down took (asked, ignored, killed after the grace) is the cleanup's compute, charged once to the task's budget.
    const usage = await call("budget.usage", { taskId });
    const compute = usage.result.item.byActivity["stop-cleanup"]?.computeMs as number | undefined;
    assert.ok(compute !== undefined && compute >= PROCESS_LIMITS.closeGraceMs && compute < PROCESS_LIMITS.closeGraceMs + PROCESS_LIMITS.killWaitMs + 5000, `stop-cleanup compute: ${JSON.stringify(usage.result.item.byActivity)}`);
    const seen = await call("status.ask", { request: { kind: "stop_cleanup", taskId } });
    assert.ok((seen.result.item.lines as { text: string }[]).some((l) => l.text.includes(`Attempt ${attempt}:`) && l.text.includes(`${compute} ms of compute charged`)), JSON.stringify(seen.result.item.lines));
    assert.ok((await call("lifecycle.sweep", {}, "sw1")).ok);
    assert.equal((await call("budget.usage", { taskId })).result.item.byActivity["stop-cleanup"].computeMs, compute, "a sweep does not charge again");
  } finally {
    await c?.close();
    await launcher.stop();
    for (const pid of holding(marker)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
