import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AdmissionService, LocalWorker, ModelRelay, RemoteOfferRunner, RemoteWorkerClient, composeAnchor, findAnchors, startController, type WorkOrder } from "@nimblenewt/controller";
import { PI, ROUTING_TABLE, workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher, appFromRepository, localWorkerParts, orderAnchor } from "@nimblenewt/worker";
import { loopbackFetch, sse } from "./h12-worker-support.js";
import { sandbox } from "./w03-rig-support.js";

// W12 follow-up end to end on a REMOTE worker host: the composed controller offers the attempt over the worker protocol (HTTP) to a `RemoteOfferRunner` whose host is the worker package's launcher and the real Pi process in its bubblewrap
// sandbox, behind a `LocalWorker`. The machine passes NO context of its own (it has none of the controller's records): the host takes the anchor from the order it was offered, the block its sealed contract names. Tool results grow the
// conversation until the real process cuts it; every model call holds exactly one anchor, at the top of the first prompt and then at the top of each summary, equal to the block the controller's records give when composed again.
// Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENT = "agt-abcdefghijklmnopqrst";
const ABILITIES = { formats: [1], features: ["limits", "wall-time"], enforces: { cpus: "full", memoryMb: "full", diskMb: "full", processes: "full", wallTimeMs: "full" } };
const WINDOW = 24576;
const until = async (ok: () => boolean | Promise<boolean>, ms: number, why: string): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(why); await new Promise((r) => setTimeout(r, 50)); } };

interface Step { readonly text?: string; readonly call?: { readonly name: string; readonly args: object } }
interface Model { readonly server: Server; readonly url: string; readonly seen: { readonly body: { messages: { role: string; content: unknown }[] } }[] }
async function model(steps: Step[]): Promise<Model> {
  const seen: Model["seen"][number][] = [];
  let at = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      const step = steps[Math.min(at++, steps.length - 1)]!;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ role: "assistant", content: "" }, null));
      // As in the local W12 test: a small input at first and a large one later, so the real process cuts its conversation after the third call.
      const prompt = at <= 3 ? 10 : 20_000;
      const usage = { prompt_tokens: prompt, completion_tokens: 3, total_tokens: prompt + 3 };
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
const textsOf = (m: Model, at: number): string[] => m.seen[at]!.body.messages.map((x) => (typeof x.content === "string" ? x.content : Array.isArray(x.content) ? (x.content as { text?: string }[]).map((p) => p.text ?? "").join("\n") : ""));

test("W12 on a remote worker: the offered order's anchor is put back at the top of every summary after the real process's cuts, exactly once, equal to the block the records give; the machine needs no context of its own", async (t) => {
  const launcher: SandboxLauncher | undefined = await sandbox(t);
  if (launcher === undefined) return;
  const READ = { name: "nimblenewt__desk-read", args: { recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" } };
  const answer = await model([...Array.from({ length: 18 }, () => ({ call: READ })), { text: "stopping here" }]);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn w12r ")));
  const c = await startController({
    storage: { kind: "sqlite", path: join(directory, "c.sqlite") }, argv: [], env: {}, print: () => undefined,
    facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [PI],
    dispatch: {
      manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } }),
      remote: {
        blobDirectory: join(directory, "blobs"), relocationPolicy: async () => ({}), placementPolicy: async () => ({ dataHosts: ["host:r1"] }),
        hosts: [{ hostId: "host:r1", window: () => WINDOW, checkpointWaitMs: 5_000, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "local-only" as const, harness: "pi" }) }],
      },
    },
  });
  let runner: RemoteOfferRunner | undefined;
  let finished: Promise<string> | undefined;
  try {
    assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
    const s = c.services;
    const owner = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
    // The route states its window in the owner's routing table, so the controller writes an anchor for it (W12: no window, no anchor).
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, routes: { ...ROUTING_TABLE.routes, "localp/small": { contextTokens: WINDOW, capabilities: ["tools"] } }, roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" } } } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: AGENT, grants: workGrants(project) as never });
    await s.principals.enroll(owner, { commandId: "e-r1", kind: "host", name: "r1", grants: [] });
    const hostToken = (await s.principals.issueCredential(owner, "host:r1")).token;
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:r1", capacity: { cpus: 8, memoryMb: 16_384 } });
    const client = new RemoteWorkerClient({ url: c.dispatch.workerUrl!, token: hostToken, workerVersion: "worker-9.1.0" });
    await client.connect({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } as never);
    await client.heartbeat(1);
    const modelRelay = new ModelRelay({ fetch: loopbackFetch, endpoint: (route) => (route === "localp/small" ? { url: answer.url, headers: () => ({ authorization: "Bearer sk-provider-secret" }) } : undefined) });
    const dirs = (order: WorkOrder) => {
      const base = join(directory, "attempts", order.attemptId);
      const made = { checkout: join(base, "checkout"), gitDir: join(base, "git"), home: join(base, "home"), scratch: join(base, "scratch") };
      for (const d of Object.values(made)) mkdirSync(d, { recursive: true });
      return made;
    };
    // The remote machine's parts: no `context` option at all (the machine has none of the controller's records).
    const parts = localWorkerParts<unknown>({
      launcher: launcher as never, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
      workspace: (order) => dirs(order as never),
      model: () => ({ alias: "m0", provider: "localp", api: "openai-completions", modelId: "local", contextWindow: WINDOW, maxTokens: 1024, reasoning: false, input: ["text"] }),
      namespaceId: () => "abcdef0123456789",
      // Every read returns a long record, so the conversation grows past the point where the process cuts it.
      bridge: async () => ({ ok: true, result: { record: { id: "dsk-aaaaaaaaaaaaaaaaaaaa", body: `A long record. ${"The seeds are kept in the shed by the door. ".repeat(500)}` } } }),
      relay: (order, request) => modelRelay.forAttempt({ route: "localp/small", model: "local", stream: runner!.tap((order as unknown as WorkOrder).attemptId) }).relay(request),
      requireEnforced: false,
    });
    const local = new LocalWorker({
      hostId: "host:r1", resources: { cpus: 1, memoryMb: 1024 }, version: "w12r-test",
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
    assert.deepEqual((await c.dispatch!.dispatcher.tick()).started, [attemptId]);
    let offer: Awaited<ReturnType<typeof client.offers>>[number] | undefined;
    for (let i = 0; i < 100 && offer === undefined; i++) offer = (await client.offers({ waitMs: 100 })).find((o) => o.order.attemptId === attemptId);
    assert.ok(offer, "the host was offered the attempt");
    // What came over the wire: the order opens with the block, the sealed contract names it, and the worker's own rule picks exactly it.
    const sent = findAnchors(offer.order.content);
    assert.equal(sent.length, 1);
    assert.equal(offer.order.contract?.anchorDigest, sent[0]!.digest);
    assert.equal(orderAnchor(offer.order as never), sent[0]!.text);
    finished = runner.run(offer);
    await until(() => answer.seen.length >= 19, 90_000, `the scripted model was called ${answer.seen.length} times`);

    const again = composeAnchor({ taskId, projectId: project, attemptId, title: "Order seeds", handoffIds: [], archiveDigests: [], recall: true }, 2400)!;
    assert.equal(sent[0]!.text, again.text, "the offered block is what the records give");
    const cuts = answer.seen.map((_, i) => i).filter((i) => textsOf(answer, i).some((x) => /compacted into the following summary/.test(x)));
    assert.ok(cuts.length >= 3, `the real process cut the conversation again and again (${cuts.length} of ${answer.seen.length} model calls came after a cut)`);
    for (let i = 0; i < answer.seen.length; i++) {
      const texts = textsOf(answer, i);
      const blocks = texts.flatMap((x) => findAnchors(x));
      assert.equal(blocks.length, 1, `call ${i}: exactly one anchor in the request (${blocks.length})`);
      assert.equal(blocks[0]!.text, again.text, `call ${i}: equal to the block the records give`);
      const first = texts[answer.seen[i]!.body.messages.findIndex((x) => x.role === "user")]!;
      if (cuts.includes(i)) assert.match(first, /^[^\n]*compacted into the following summary[^\n]*\n+<summary>\n\[NN-ANCHOR v1 /, `call ${i}: the anchor opens the summary`);
      else assert.ok(first.startsWith(again.text), `call ${i}: at the top of the first prompt`);
    }
  } finally {
    answer.server.closeAllConnections(); answer.server.close();
    await c.close();
    await finished?.catch(() => undefined);
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
