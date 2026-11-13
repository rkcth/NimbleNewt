import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AdmissionService, GenerationService, startController } from "@nimblenewt/controller";
import { PI, workGrants } from "@nimblenewt/controller/testing";
import { sse } from "./h12-worker-support.js";
import { sandbox } from "./w03-rig-support.js";

// Card L05e with a REAL worker process: `node scripts/remote-worker.mjs --config ...` is started as a child process on this machine. It speaks the worker protocol to the controller over HTTP, runs the agent's Pi process in its bubblewrap
// sandbox, records every model call through the protocol, sends the process's tool requests through the protocol's tool route to the controller's real bridge and reports the result. The model is scripted. Skipped without bubblewrap unless
// NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENT = "agt-abcdefghijklmnopqrst";
const SECRET_TOKEN_MARK = "sk-provider-secret-l05e";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, why: () => string, ms = 120_000): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(why()); await sleep(100); } };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

interface Step { readonly think?: string; readonly call?: { readonly name: string; readonly args: object }; readonly text?: string }
async function model(steps: Step[]): Promise<{ server: Server; url: string; seen: { body: string; authorization: string | undefined }[] }> {
  const seen: { body: string; authorization: string | undefined }[] = [];
  let at = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ body, authorization: req.headers.authorization });
      const summary = body.includes("context summarization assistant");
      const step: Step = summary ? { text: "## Summary\nThe task is to order seeds." } : steps[Math.min(at++, steps.length - 1)]!;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ role: "assistant", content: "" }, null));
      const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
      if (step.think !== undefined) res.write(sse({ reasoning_content: step.think }, null));
      if (step.call !== undefined) {
        res.write(sse({ tool_calls: [{ index: 0, id: `call_${at}`, type: "function", function: { name: step.call.name, arguments: JSON.stringify(step.call.args) } }] }, null));
        res.write(sse({}, "tool_calls", usage));
      } else { res.write(sse({ content: step.text ?? "done" }, null)); res.write(sse({}, "stop", usage)); }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen };
}

test("a remote worker program in a real process takes an offer over the protocol, runs Pi in its sandbox, records the model call, sends the tool call through the tool route to the controller's bridge and reports the result; nothing it prints holds a credential (card L05e)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  await launcher.stop();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn l05e ")));
  const shared = join(directory, "shared");
  mkdirSync(join(shared, "src"), { recursive: true });
  git(directory, "init", "-q", "-b", "main", shared);
  writeFileSync(join(shared, "src", "a.ts"), "export const a = 1;\n");
  git(shared, "add", "-A"); git(shared, "commit", "-q", "-m", "first");
  const THOUGHT = "The seeds go in the east bed before the rain.";
  const answer = await model([{ think: THOUGHT, call: { name: "nimblenewt__work-end", args: { report: "Beans planted.", result: "done", note: "beans" } } }, { text: "Ended." }]);
  const c = await startController({
    storage: { kind: "sqlite", path: join(directory, "c.sqlite") }, argv: [], env: {}, print: () => undefined,
    facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [PI],
    tools: { runner: { run: async () => { throw new Error("no script call runs in this test"); } } as never, isLocalHost: () => false },
    dispatch: {
      manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } }),
      remote: {
        blobDirectory: join(directory, "blobs"), relocationPolicy: async () => ({}), placementPolicy: async () => ({ dataHosts: ["host:r1"] }),
        hosts: [{ hostId: "host:r1", window: () => 131_072, checkpointWaitMs: 5_000, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "local-only" as const, harness: "pi" }) }],
      },
    },
  });
  let child: ReturnType<typeof spawn> | undefined;
  const out: string[] = [];
  try {
    assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
    const s = c.services;
    const owner = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: AGENT, grants: workGrants(project) as never });
    await s.principals.enroll(owner, { commandId: "e-r1", kind: "host", name: "r1", grants: [] });
    const hostToken = (await s.principals.issueCredential(owner, "host:r1")).token;
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:r1", capacity: { cpus: 8, memoryMb: 16_384 } });
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Order seeds" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;

    // The configuration holds no credential; the credentials are in the child's environment.
    const configFile = join(directory, "worker.json");
    writeFileSync(configFile, JSON.stringify({ url: c.dispatch.workerUrl, hostId: "r1", workerVersion: "l05e-test", base: join(directory, "host"), projects: { [project]: shared }, routes: { "localp/small": { url: answer.url, keyEnv: "L05E_PROVIDER_KEY", contextTokens: 131072, maxTokens: 1024 } }, poller: { spreadMs: 0, waitMs: 200, heartbeatMs: 1000, minGapMs: 50 } }));
    child = spawn(process.execPath, [join(repository, "scripts", "remote-worker.mjs"), "--config", configFile], { env: { ...process.env, NODE_OPTIONS: "", NIMBLENEWT_WORKER_TOKEN: hostToken, L05E_PROVIDER_KEY: SECRET_TOKEN_MARK }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (d: Buffer) => out.push(d.toString("utf8")));
    child.stderr!.on("data", (d: Buffer) => out.push(d.toString("utf8")));
    const exited = new Promise<number | null>((r) => child!.once("exit", (code) => r(code)));
    void exited.then((code) => { if (code !== null && code !== 0) out.push(`[exited ${code}]`); });

    // The host connects by itself; the dispatcher places the attempt on it when it can.
    let started = false;
    await until(async () => { if (!started) started = (await c.dispatch!.dispatcher.tick()).started.includes(attemptId); return started; }, () => `the attempt was never started on the remote host: ${out.join("")}`);
    await until(async () => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))?.outcome !== undefined, () => `the attempt never ended: ${out.join("")}`);
    const d = (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))!;
    assert.equal(d.outcome?.status, "succeeded", `${JSON.stringify(d.outcome)} ${out.join("")}`);

    // The model call was recorded by the controller as a generation bound to the remote attempt, and the tool call that ended the task came through the route.
    const run = (await GenerationService.withEpoch(c.storage, c.epoch).view(owner, GenerationService.runIdOf(taskId, 1)))!.run;
    assert.equal(run.fence?.attemptId, attemptId, "the generation is bound to the remote attempt");
    assert.ok(run.toolCalls.some((call) => call.name === "nimblenewt__work-end"), "the model's tool call was recorded by the controller");
    // Card U09c: the thinking the model returned crossed the protocol's thinking route to the controller's store, and the owner reads it as they read a local host's. The text is in no line the program printed.
    const ownerToken = (await s.principals.issueCredential(owner, owner.id)).token;
    let looked: any;
    await until(async () => { looked = await c.api.handle(ownerToken, { v: 1, op: "activity.replay.thinking", commandId: `look-${Math.random()}`, args: { taskId, reason: "what was it weighing" } } as never); return looked.ok === true; }, () => `the remote host's thinking never reached the store: ${JSON.stringify(looked)} ${out.join("")}`, 20_000);
    assert.ok(looked.result.blocks.some((b: { text: string }) => b.text.includes(THOUGHT)), JSON.stringify(looked.result.blocks));
    assert.equal(out.join("").includes(THOUGHT), false, "the program prints no thinking");
    // The program's only way to the controller's bridge is the tool route, and a task ends as `succeeded` only by the work.end call Pi made, which the bridge answered.
    assert.ok(answer.seen.length >= 1);
    assert.equal(answer.seen[0]!.authorization, `Bearer ${SECRET_TOKEN_MARK}`, "the provider key reached the provider from the host's environment, by the name the configuration gave");
    await until(() => out.join("").includes(`attempt ${attemptId} completed`), () => `the host did not say the attempt completed: ${out.join("")}`, 20_000);

    // Card L02e: the deployed program reports what its sandbox holds. Its last word (after the sandbox was stopped) is on the placement: final, saying it can answer a fresh look, and listing nothing the agent left behind.
    let report: { final: boolean; canLook?: boolean; processes: unknown[]; placement: number } | undefined;
    await until(async () => { report = ((await c.storage.getAggregate({ kind: "remote-placement", id: attemptId }))?.body as unknown as { processReport?: typeof report } | undefined)?.processReport; return report?.final === true; }, () => `the program never gave its final process report: ${JSON.stringify(report)} ${out.join("")}`, 20_000);
    assert.equal(report!.canLook, true, "the program says it can answer a look");
    assert.deepEqual(report!.processes, [], `a finished attempt left nothing in its sandbox: ${JSON.stringify(report)}`);

    // Nothing the program printed holds the host credential, the task credential or the provider key, and the configuration file holds none.
    const printed = out.join("");
    for (const secret of [hostToken, SECRET_TOKEN_MARK]) { assert.equal(printed.includes(secret), false); assert.equal(readFileSync(configFile, "utf8").includes(secret), false); }
    child.kill("SIGTERM");
    assert.equal(await exited, 0, "a stop signal ends the program cleanly");
  } finally {
    if (child !== undefined && child.exitCode === null) child.kill("SIGKILL");
    answer.server.closeAllConnections(); answer.server.close();
    await c.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
