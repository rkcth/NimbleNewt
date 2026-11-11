import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AdmissionService, GenerationService, LocalWorker, ModelRelay, RemoteOfferRunner, RemoteWorkerClient, startController, type WorkOrder } from "@nimblenewt/controller";
import { PI, workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher, appFromRepository, localWorkerParts } from "@nimblenewt/worker";
import { loopbackFetch, sse } from "./h12-worker-support.js";
import { sandbox } from "./w03-rig-support.js";

// Card L05d with the real worker process on a remote worker host: the host is the worker package's launcher and the Pi process in its bubblewrap sandbox, behind a `LocalWorker`, driven by a `RemoteOfferRunner` that speaks the remote protocol
// to the controller over HTTP. The machine's model relay takes the runner's stream tap, so every model call Pi makes is recorded by the controller as a revision-bound generation; the tool calls Pi makes go to the controller's tool bridge,
// which checks them against the recorded generation. The model is scripted. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENT = "agt-abcdefghijklmnopqrst";
const ODD_ID = "call:odd id/with spaces";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, why: string, ms = 90_000): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(why); await sleep(50); } };
const gate = (): { promise: Promise<void>; open: () => void } => { let open!: () => void; const promise = new Promise<void>((r) => { open = r; }); return { promise, open }; };
const ABILITIES = { formats: [1], features: ["limits", "wall-time"], enforces: { cpus: "full", memoryMb: "full", diskMb: "full", processes: "full", wallTimeMs: "full" } };
const END = (report: string) => ({ name: "nimblenewt__work-end", args: { report, result: "done", note: "beans" } });

interface Step { readonly hold?: Promise<void>; readonly call?: { readonly name: string; readonly args: object; readonly id?: string }; readonly text?: string }
/** A model endpoint playing the steps in order; a step with `hold` sends its first bytes at once and the rest when released. */
async function model(steps: Step[]): Promise<{ server: Server; url: string; seen: string[] }> {
  const seen: string[] = [];
  let at = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push(Buffer.concat(chunks).toString("utf8"));
      // Pi may summarise its conversation between turns; that call is answered with a summary and is not one of the scripted steps.
      const summary = seen[seen.length - 1]!.includes("context summarization assistant");
      const step: Step = summary ? { text: "## Summary\nThe task is to order seeds." } : steps[Math.min(at++, steps.length - 1)]!;
      let gone = false;
      res.on("close", () => { gone = true; });
      void (async () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sse({ role: "assistant", content: "" }, null));
        if (step.hold !== undefined) await step.hold;
        if (gone) return;
        const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
        if (step.call !== undefined) {
          res.write(sse({ tool_calls: [{ index: 0, id: step.call.id ?? `call_${at}`, type: "function", function: { name: step.call.name, arguments: JSON.stringify(step.call.args) } }] }, null));
          res.write(sse({}, "tool_calls", usage));
        } else { res.write(sse({ content: step.text ?? "done" }, null)); res.write(sse({}, "stop", usage)); }
        res.end("data: [DONE]\n\n");
      })();
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen };
}

/** The controller, a remote host that runs Pi in its sandbox, and one attempt offered to it. */
async function rig(launcher: SandboxLauncher, steps: Step[], bridgeGate?: Promise<void>) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn l05d ")));
  const answer = await model(steps);
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
  assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
  const s = c.services;
  const owner = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
  const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
  await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: AGENT, grants: workGrants(project) as never });
  await s.principals.enroll(owner, { commandId: "e-r1", kind: "host", name: "r1", grants: [] });
  const hostToken = (await s.principals.issueCredential(owner, "host:r1")).token;
  await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:r1", capacity: { cpus: 8, memoryMb: 16_384 } });
  const client = new RemoteWorkerClient({ url: c.dispatch.workerUrl!, token: hostToken, workerVersion: "worker-9.1.0" });
  await client.connect({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } as never);
  await client.heartbeat(1);
  const bridged: { op: string; callId: string; reply?: unknown }[] = [];
  let runner: RemoteOfferRunner | undefined;
  const modelRelay = new ModelRelay({ fetch: loopbackFetch, endpoint: (route) => (route === "localp/small" ? { url: answer.url, headers: () => ({ authorization: "Bearer sk-provider-secret" }) } : undefined) });
  const dirs = (order: WorkOrder) => {
    const base = join(directory, "attempts", order.attemptId);
    const made = { checkout: join(base, "checkout"), gitDir: join(base, "git"), home: join(base, "home"), scratch: join(base, "scratch") };
    for (const d of Object.values(made)) mkdirSync(d, { recursive: true });
    return made;
  };
  const parts = localWorkerParts<Parameters<NonNullable<typeof c.tools>["handle"]>[1]["call"]>({
    launcher: launcher as never, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
    workspace: (order) => dirs(order as never),
    model: () => ({ alias: "m0", provider: "localp", api: "openai-completions", modelId: "local", contextWindow: 131_072, maxTokens: 1024, reasoning: false, input: ["text"] }),
    namespaceId: () => "abcdef0123456789",
    // The tool bridge is the controller's, bound to the remote attempt: a call the process makes is checked there against the generation that recorded it.
    bridge: async (order, call, token, request) => {
      const entry: { op: string; callId: string; reply?: unknown } = { op: request.op, callId: request.callId };
      bridged.push(entry);
      if (request.op === "work.end" && bridged.filter((b) => b.op === "work.end").length === 1 && bridgeGate !== undefined) await bridgeGate;
      entry.reply = await c.tools!.handle(token, { attemptId: (order as unknown as WorkOrder).attemptId, call }, request as never);
      return entry.reply as never;
    },
    // The machine's relay: its stream is the runner's tap for the attempt, which is the attempt's protocol tap.
    relay: (order, request) => modelRelay.forAttempt({ route: "localp/small", model: "local", stream: runner!.tap((order as unknown as WorkOrder).attemptId) }).relay(request),
    requireEnforced: false,
  });
  const local = new LocalWorker({
    hostId: "host:r1", resources: { cpus: 1, memoryMb: 1024 }, version: "l05d-test",
    schedule: (beat) => { const timer = setInterval(() => { void beat(); }, 100); return () => clearInterval(timer); },
    sandbox: parts.sandbox as never, runtimes: { open: (order, call, from) => parts.runtimes.open(order as never, call as never, from as never) as never },
    capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }) as never,
  });
  runner = new RemoteOfferRunner({ client, host: local, abilities: ABILITIES as never, controlMs: 100, stream: { batchMs: 0, batchChars: 0 } });
  const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Order seeds" })).id;
  await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
  await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: AGENT } });
  const a = (await s.assignments.getAssignment(taskId))!;
  const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
  const generation = GenerationService.withEpoch(c.storage, c.epoch);
  const view = async (n: number) => (await generation.view(owner, GenerationService.runIdOf(taskId, n)))?.run;
  /** Starts the attempt on the remote host and runs the offer in the background. */
  const start = async (): Promise<{ finished: Promise<string> }> => {
    assert.deepEqual((await c.dispatch!.dispatcher.tick()).started, [attemptId]);
    let offer: Awaited<ReturnType<typeof client.offers>>[number] | undefined;
    for (let i = 0; i < 100 && offer === undefined; i++) { const got = await client.offers({ waitMs: 100 }); offer = got.find((o) => o.order.attemptId === attemptId); }
    assert.ok(offer, "the host was offered the attempt");
    return { finished: runner!.run(offer) };
  };
  return {
    c, owner, taskId, attemptId, generation, view, start, bridged, answer,
    get: async () => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))!,
    close: async () => { answer.server.closeAllConnections(); answer.server.close(); await c.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); },
  };
}

test("a remote worker's Pi process in its sandbox: a reply that arrives after the owner's correction is held back at the controller and never reaches the process, and the task is not ended by it (card L05d)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  const late = gate();
  const x = await rig(launcher, [{ hold: late.promise, call: { ...END("STALE-REPORT-5 tomatoes"), id: ODD_ID } }, { call: END("Beans planted.") }, { text: "Ended." }]);
  try {
    const { finished } = await x.start();
    await until(async () => (await x.view(1))?.state === "streaming", "the remote worker's stream was never recorded");
    assert.equal((await x.view(1))!.fence?.attemptId, x.attemptId, "the generation is bound to the remote attempt that streams it");
    await x.generation.correct(x.owner, { commandId: "fix", taskId: x.taskId, expectedContextRevision: 1, reason: "use beans, not tomatoes" });
    late.open();
    assert.equal(await finished, "completed");
    const first = (await x.view(1))!;
    assert.equal(first.state, "interrupted");
    assert.equal(first.interrupted?.kind, "corrected");
    assert.ok(first.late.some((l) => l.kind === "tool_call"), "the late call arrived and is recorded as late");
    assert.deepEqual(first.toolCalls, [], "it is not a call of the generation");
    assert.equal((await x.view(2))?.contextRevision, 2);
    const d = await x.get();
    assert.equal(d.outcome?.status, "succeeded", d.outcome?.summary);
    assert.equal(JSON.stringify(d).includes("STALE-REPORT-5"), false);
    assert.equal(x.answer.seen.slice(1).join("\n").includes("STALE-REPORT-5"), false, "the held call is in nothing the model was later shown");
    assert.match(x.answer.seen.slice(1).join("\n"), /use beans, not tomatoes/);
  } finally { late.open(); await x.close(); }
});

test("a remote worker's tool call of a corrected generation reaches the bridge under the ID the extension rewrote and is refused there, by its recorded generation; the next generation's call ends the task (card L05d)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  const hold = gate();
  const x = await rig(launcher, [{ call: { ...END("STALE-REPORT-6 tomatoes"), id: ODD_ID } }, { call: END("Beans planted.") }, { text: "Ended." }], hold.promise);
  try {
    const { finished } = await x.start();
    // The reply is whole and recorded; the process has made its call, which waits at the machine's bridge.
    const ends = () => x.bridged.filter((b) => b.op === "work.end");
    await until(() => ends().length === 1, `the process never made its tool call: ${JSON.stringify(x.bridged)}`);
    const first = (await x.view(1))!;
    assert.equal(first.toolCalls[0]?.state, "complete");
    assert.ok(ends()[0]!.callId.startsWith("h:"), `the extension sent the rewritten ID: ${ends()[0]!.callId}`);
    assert.deepEqual(first.toolCalls[0]?.aliases, [ends()[0]!.callId], "the recorded call knows the ID the bridge will see");
    await x.generation.correct(x.owner, { commandId: "fix", taskId: x.taskId, expectedContextRevision: 1, reason: "use beans, not tomatoes" });
    hold.open();
    assert.equal(await finished, "completed");
    const refused = ends()[0]!.reply as { ok: boolean; code?: string; message?: string };
    assert.ok(!refused.ok && refused.code === "generation_refused", JSON.stringify(refused));
    assert.match(refused.message ?? "", /corrected/);
    const after = (await x.view(1))!;
    assert.equal(after.toolCalls[0]?.state, "withdrawn");
    assert.equal(after.toolCalls[0]?.effectId, undefined, "no effect was started for it");
    const d = await x.get();
    assert.equal(d.outcome?.status, "succeeded", `${d.outcome?.summary} ${JSON.stringify(x.bridged)}`);
    assert.equal(JSON.stringify(d).includes("STALE-REPORT-6"), false, "the stale report did not end the task");
    assert.equal((await x.view(2))?.contextRevision, 2);
  } finally { hold.open(); await x.close(); }
});
