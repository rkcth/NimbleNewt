import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AdmissionService, startController } from "@nimblenewt/controller";
import { PI, workGrants } from "@nimblenewt/controller/testing";
import { sse } from "./h12-worker-support.js";
import { sandbox } from "./w03-rig-support.js";

// Card L04e with a REAL remote worker process (`scripts/remote-worker.mjs`, bubblewrap, a real Pi process, a scripted offline model), the other half of the local test: the task runs on a remote host, whose Pi process reads its checkpoint back
// from its store; the checkpoint travels to the controller WITH the turn's result and is captured as a complete continuation (the host's `durable` check in it); the next run is checked against that capture; and the task's recorded files are
// looked at again by the REMOTE host on its own disk (the `observe` request over the worker channel), so they come back changed or unchanged, never unknown; keys outside the checkout stay unknown. Skipped without bubblewrap unless
// NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENT = "agt-abcdefghijklmnopqrst";
const SECRET = "sk-provider-secret-l04e";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, why: () => string, ms = 120_000): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(why()); await sleep(100); } };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

interface Step { readonly call?: { readonly name: string; readonly args: object }; readonly text?: string }
async function model(steps: Step[]): Promise<{ server: Server; url: string; seen: string[] }> {
  const seen: string[] = [];
  let at = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const summary = body.includes("context summarization assistant");
      if (!summary) seen.push(JSON.stringify((JSON.parse(body) as { messages?: unknown }).messages));
      const step: Step = summary ? { text: "## Summary\nThe parser task." } : steps[Math.min(at++, steps.length - 1)]!;
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

test("a task on a real remote worker: its Pi turn is captured as a complete continuation with the worker's read-back check, the next run is checked against it, and the remote host looks at the task's recorded files on its own disk: changed or unchanged, not unknown (card L04e)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  await launcher.stop();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn l04e ")));
  const shared = join(directory, "shared");
  mkdirSync(join(shared, "src"), { recursive: true });
  git(directory, "init", "-q", "-b", "main", shared);
  writeFileSync(join(shared, "src", "a.ts"), "export const a = 1;\n");
  git(shared, "add", "-A"); git(shared, "commit", "-q", "-m", "first");
  const stop = [{ text: "First I read the parser." }, { text: "Still reading." }, { text: "Still reading." }, { text: "Still reading." }];
  const answer = await model([...stop, { call: { name: "nimblenewt__work-end", args: { report: "Done as the task asked.", result: "done", note: "parser fixed" } } }, { text: "Ended: the parser is fixed." }]);
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
    const ownerToken = (await s.principals.issueCredential(owner, owner.id)).token;
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(ownerToken, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    // Card P02 (remote hosts): the host declares the folder its configuration names for the project, and is sent the work only when that folder is bound to the project with write access.
    await s.resources.bindResource(owner, { commandId: "bind-garden", projectId: project, kind: "repository", label: "garden", locator: shared, repositoryId: "garden", access: "write" });
    await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: AGENT, grants: workGrants(project) as never });
    await s.principals.enroll(owner, { commandId: "e-r1", kind: "host", name: "r1", grants: [] });
    const hostToken = (await s.principals.issueCredential(owner, "host:r1")).token;
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:r1", capacity: { cpus: 8, memoryMb: 16_384 } });
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Fix the parser" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
    const configFile = join(directory, "worker.json");
    writeFileSync(configFile, JSON.stringify({ url: c.dispatch.workerUrl, hostId: "r1", workerVersion: "l04e-test", base: join(directory, "host"), projects: { [project]: shared }, routes: { "localp/small": { url: answer.url, keyEnv: "L04E_PROVIDER_KEY", contextTokens: 131072, maxTokens: 1024 } }, poller: { spreadMs: 0, waitMs: 200, heartbeatMs: 1000, minGapMs: 50 } }));
    child = spawn(process.execPath, [join(repository, "scripts", "remote-worker.mjs"), "--config", configFile], { env: { ...process.env, NODE_OPTIONS: "", NIMBLENEWT_WORKER_TOKEN: hostToken, L04E_PROVIDER_KEY: SECRET }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (d: Buffer) => out.push(d.toString("utf8")));
    child.stderr!.on("data", (d: Buffer) => out.push(d.toString("utf8")));
    const exited = new Promise<number | null>((r) => child!.once("exit", (code) => r(code)));
    const get = async () => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))!;
    const maybe = async () => await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId);

    // Run 1: the real Pi process on the remote host stops without work.end (after its nudges) and the attempt waits to go on from its checkpoint.
    // The dispatcher is ticked only until the attempt has started: a tick after the turn stopped would resume it at once (nothing holds it yet), before the test has recorded what the agent relied on.
    let last: { state?: string; startedAt?: string; resumeFrom?: unknown } | undefined;
    await until(async () => { if (last?.startedAt === undefined) await c.dispatch!.dispatcher.tick(); last = await maybe() as typeof last; return last?.state === "waiting" && last.resumeFrom !== undefined; }, () => `the first turn never ended: ${JSON.stringify(last)} ${out.join("")}`);
    const d1 = await get();
    const pi = (d1.resumeFrom as { pi?: { digest?: string } }).pi;
    assert.deepEqual((d1.resumeFrom as { nn?: { durable?: unknown } }).nn?.durable, { verified: true }, "the remote host's Pi process read its checkpoint back and said so");
    const latest = (await call("continuation.latest", { taskId })).result.item;
    assert.ok(latest !== undefined, `the remote turn was captured: ${out.join("")}`);
    assert.equal(latest.status, "complete");
    assert.equal(latest.checkpoint.digest, pi!.digest, "the capture is of the checkpoint the next run restores");

    // The agent's recorded files live on the REMOTE host's disk (its checkout); the controller's disk holds none of them. The work moved on there: one file changed, one did not.
    const checkout = join(directory, "host", "work", project, taskId, "checkout");
    assert.ok(existsSync(join(checkout, "src", "a.ts")), "the remote host's checkout of the task");
    writeFileSync(join(checkout, "src", "kept.ts"), "export const kept = 1;\n");
    const recorded = await call("resume.dependencies.record", { taskId, dependencies: [
      { kind: "file", key: "src/a.ts", hash: sha("export const a = 1;\n") },
      { kind: "file", key: "src/kept.ts", hash: sha("export const kept = 1;\n") },
      { kind: "file", key: "../../../../outside.txt", hash: sha("o") },
    ] }, "dep1");
    assert.deepEqual(recorded.result, { recorded: 3 }, JSON.stringify(recorded));
    writeFileSync(join(checkout, "src", "a.ts"), "export const a = 2;\n");

    // Run 2: held by the resume check, against that capture, with the remote host's own look at the files.
    let check: any;
    await until(async () => { await c.dispatch!.dispatcher.tick(); check = (await call("resume.for-task", { taskId })).result?.item; return check?.phase === "ready"; }, () => `the resume check never held the attempt: ${JSON.stringify(check)} ${out.join("")}`);
    assert.equal(check.continuationId, latest.id);
    assert.deepEqual(check.delta.changed.map((x: { key: string; status: string }) => [x.key, x.status]).sort(), [["../../../../outside.txt", "unknown"], ["src/a.ts", "changed"]]);
    assert.equal(check.delta.unchanged, 1, "the file that did not change on the remote disk is unchanged");
    assert.equal(JSON.stringify(check).includes("export const"), false, "no file content crossed to the controller");
    assert.equal(JSON.stringify(check).includes(directory), false, "no path of the host's disk crossed either");
    assert.equal((await get()).state, "waiting");
    assert.equal(answer.seen.length, 4, "no model call while the check was held");

    assert.equal((await call("resume.approve", { taskId }, "ok")).result.item.phase, "done");
    await until(async () => { await c.dispatch!.dispatcher.tick(); return (await maybe())?.outcome !== undefined; }, () => `the resumed attempt never ended: ${out.join("")}`);
    assert.equal((await get()).outcome?.status, "succeeded", JSON.stringify((await get()).outcome));
    assert.match(answer.seen[4]!, /First I read the parser\./, "the real process on the remote host continued the same conversation");
    assert.equal((await c.storage.listAggregates("continuation-resume", { limit: 10 })).length, 1, "one resume recorded");
    const printed = out.join("");
    for (const secret of [hostToken, SECRET]) assert.equal(printed.includes(secret), false);
    assert.equal(printed.includes("export const"), false, "the program prints no file content");
    assert.equal(readFileSync(configFile, "utf8").includes(SECRET), false);
    child.kill("SIGTERM");
    assert.equal(await exited, 0, "a stop signal ends the program cleanly");
  } finally {
    if (child !== undefined && child.exitCode === null) child.kill("SIGKILL");
    answer.server.closeAllConnections(); answer.server.close();
    await c.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
