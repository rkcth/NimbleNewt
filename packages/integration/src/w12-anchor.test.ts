import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AdmissionService, DifficultyService, HostService, LocalWorker, ModelRelay, PolicyService, composeAnchor, findAnchors, startController } from "@nimblenewt/controller";
import { EXEC_PROFILES, PI, ROUTING_TABLE, workGrants } from "@nimblenewt/controller/testing";
import { findAnchors as workerFindAnchors, stripAnchors as workerStripAnchors } from "@nimblenewt/contracts";
import { SandboxLauncher, appFromRepository, localWorkerParts } from "@nimblenewt/worker";
import { loopbackFetch, sse } from "./h12-worker-support.js";

// Card W12 end to end: the composed controller, the real sandboxed worker process running Pi, a scripted model behind the controller's relay. The dispatcher writes the anchor from the task's records and puts it at the top of the first prompt; the
// tool results grow the conversation until the real process cuts it (its own compaction); every model call after the cut carries exactly one anchor, at the top of the summary that replaced the cut conversation, equal to the block the records give
// when composed again. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const skipOrFail = (t: { skip(why: string): void }, why: string): void => { if (required) assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the check cannot run: ${why}`); t.skip(why); };
const AGENT = "agt-abcdefghijklmnopqrst";
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
      // The provider reports a small input at first and a large one later: Pi judges the conversation by what the provider reports, so it cuts it after the third call, as a conversation that has grown past the window is.
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
/** The text of every message of a request, in order (a message's parts joined). */
const textsOf = (m: Model, at: number): string[] => m.seen[at]!.body.messages.map((x) => (typeof x.content === "string" ? x.content : Array.isArray(x.content) ? (x.content as { text?: string }[]).map((p) => p.text ?? "").join("\n") : ""));

test("W12: the first prompt opens with the anchor the dispatcher wrote; after the real process cuts the conversation every model call holds exactly one anchor, at the top, equal to the block the records give when composed again; the attempt's record names its digest", async (t) => {
  const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const backend = process.platform === "darwin" ? "seatbelt" : "bubblewrap";
  if (!(launcher.capacity.available && launcher.capacity.backend === backend && !["/usr", "/bin", "/lib"].includes(nodeRoot))) return skipOrFail(t, "the sandbox of this OS (bubblewrap, Seatbelt) or a node install it can mount is unusable");
  const READ = { name: "nimblenewt__desk-read", args: { recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" } };
  const answer = await model([...Array.from({ length: 18 }, () => ({ call: READ })), { text: "stopping here" }]);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn w12 ")));
  const dirsOf = (agent: string) => {
    const base = join(directory, "agents", agent.replace(/[^A-Za-z0-9-]/g, "_"));
    const dirs = { checkout: join(base, "checkout"), gitDir: join(base, "git"), home: join(base, "home"), scratch: join(base, "scratch") };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    return dirs;
  };
  const WINDOW = 24576;
  let local: LocalWorker | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(directory, "c.sqlite") }, argv: [], env: {}, print: () => undefined,
    facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [PI],
    dispatch: {
      manual: true,
      local: {
        acceptUnenforcedLimits: true, window: () => WINDOW,
        build: (services) => {
          const relay = new ModelRelay({ fetch: loopbackFetch, endpoint: (route) => (route === "localp/small" ? { url: answer.url, headers: () => ({ authorization: "Bearer sk-provider-secret" }) } : undefined) });
          const parts = localWorkerParts<unknown>({
            launcher: launcher as never, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
            workspace: (order) => dirsOf(order.agentId),
            model: () => ({ alias: "m0", provider: "localp", api: "openai-completions", modelId: "local", contextWindow: WINDOW, maxTokens: 1024, reasoning: false, input: ["text"] }),
            namespaceId: () => "abcdef0123456789",
            // Every read of the record returns a long body, so the conversation grows past the point where the process cuts it.
            bridge: async () => ({ ok: true, result: { record: { id: "dsk-aaaaaaaaaaaaaaaaaaaa", body: `A long record. ${"The seeds are kept in the shed by the door. ".repeat(500)}` } } }),
            relay: (order, request) => services.attemptRelay(order as never, relay, { model: "local" }).relay(request),
            context: (order) => services.context(order as never),
            requireEnforced: false, guestPaths: process.platform === "darwin" ? "host" : "private",
            heldForReview: (order) => c.dispatch!.dispatcher.heldForReview(order.attemptId),
          });
          local = new LocalWorker({
            hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "w12-test", guards: services.guards,
            schedule: (beat) => { const timer = setInterval(() => { void beat(); }, 100); return () => clearInterval(timer); },
            sandbox: parts.sandbox as never, runtimes: { open: (order, call, from) => parts.runtimes.open(order as never, call, from as never) as never },
            capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }) as never,
          });
          return local;
        },
      },
    },
  });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" } } } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
    await local!.register(HostService.withEpoch(c.storage, c.epoch, s.assignments), hostP);
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: AGENT, grants: [...workGrants(project), { action: "message.receive", project }] });
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Order seeds" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
    assert.deepEqual((await c.dispatch!.dispatcher.tick() as unknown as { started: string[] }).started, [attemptId]);
    await c.dispatch!.dispatcher.idle();
    await until(() => answer.seen.length >= 19, 60_000, `the scripted model was called ${answer.seen.length} times`);

    // What the records give: the block the controller wrote, composed again.
    const again = composeAnchor({ taskId, projectId: project, attemptId, title: "Order seeds", handoffIds: [], archiveDigests: [] }, 2400)!;
    const rec = (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))!;
    assert.deepEqual(rec.anchors?.map((x) => x.digest), [again.digest], "the attempt records what the agent was shown, by digest");

    const cuts = answer.seen.map((_, i) => i).filter((i) => textsOf(answer, i).some((x) => /compacted into the following summary/.test(x)));
    assert.ok(cuts.length >= 3, `the real process cut the conversation again and again (${cuts.length} of ${answer.seen.length} model calls came after a cut): the anchor is replaced each time, never stacked`);
    for (let i = 0; i < answer.seen.length; i++) {
      const texts = textsOf(answer, i);
      const blocks = texts.flatMap((x) => findAnchors(x));
      assert.equal(blocks.length, 1, `call ${i}: exactly one anchor in the request (${blocks.length})`);
      assert.equal(blocks[0]!.text, again.text, `call ${i}: equal to the block the records give`);
      assert.deepEqual(workerFindAnchors(texts.join("\n")).map((b) => b.digest), [again.digest], "the worker's restated reader finds the same one");
      const read = [textsOf(answer, i)[answer.seen[i]!.body.messages.findIndex((x) => x.role === "user")]!];
      if (cuts.includes(i)) {
        assert.match(read[0]!, /^[^\n]*compacted into the following summary[^\n]*\n+<summary>\n\[NN-ANCHOR v1 /, `call ${i}: the anchor opens the summary that is the first thing the model reads after the system text`);
        assert.equal(workerStripAnchors(read[0]!).includes("NN-ANCHOR"), false, "taking the block out leaves no trace of the frame");
      } else assert.ok(read[0]!.startsWith(again.text), `call ${i}: at the top of the first prompt`);
    }
    // The first prompt is the task after the block.
    assert.ok(textsOf(answer, 0)[answer.seen[0]!.body.messages.findIndex((x) => x.role === "user")]!.startsWith(`${again.text}\n\nOrder seeds`));
  } finally { answer.server.closeAllConnections(); answer.server.close(); await c.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
