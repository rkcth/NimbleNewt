import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AdmissionService, DifficultyService, HostService, LocalWorker, ModelRelay, PolicyService, startController, type WorkOrder } from "@nimblenewt/controller";
import { EXEC_PROFILES, PI, ROUTING_TABLE, workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher, appFromRepository, localWorkerParts } from "@nimblenewt/worker";
import { PI_AGENT_LAYOUT, sharedSystemText } from "@nimblenewt/pi-adapter";
import { endpoint, loopbackFetch } from "./h12-worker-support.js";

// Card C07g through the composed controller and the real worker process (Pi in the real sandbox): a task that last ran on another route starts on a route nobody has measured. The dispatcher builds the owner's context
// for that route on the assumed fixed part; the worker's process comes up, says what it really sends besides the prompt, the route is measured with that and the view is built again before the first call. The model gets the
// measured view; the items cut to fit are named by digests that read their full text back. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENT = "agt-abcdefghijklmnopqrst";
const HEADER = "[The owner's decisions, goals, permissions and open questions for this task, rebuilt for model route localp/small (a 32768-token window).]";
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };

test("a task that moves to a route nobody has measured: the real process is measured before its first call and the model gets the owner's context rebuilt on the measured figure, with the cut items readable by digest (card C07g)", async (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") return t.skip("no sandbox launcher is provided for this OS (card A03b's remainder)");
  const real = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const backend = process.platform === "darwin" ? "seatbelt" : "bubblewrap";
  const usable = real.capacity.available && real.capacity.backend === backend && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  if (!usable) { if (required) assert.fail(`the sandbox is required but unusable: ${real.capacity.reason}`); return t.skip("the sandbox of this OS or a node install it can mount is unusable"); }
  const model = await endpoint([{ call: { name: "nimblenewt__work-end", args: { result: "done" } } }, { text: "watered" }]);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn c07g ")));
  const dirs = { checkout: join(directory, "checkout"), gitDir: join(directory, "git"), home: join(directory, "home"), scratch: join(directory, "scratch") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  // What the dispatcher handed the host: the order with the view built on the assumed fixed part.
  const orders: WorkOrder[] = [];
  let local: LocalWorker | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(directory, "c.sqlite") }, argv: [], env: {}, print: () => undefined,
    facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [PI],
    dispatch: {
      manual: true,
      local: {
        acceptUnenforcedLimits: true,
        window: () => 32_768,
        build: (services) => {
          const relay = new ModelRelay({ fetch: loopbackFetch, endpoint: (route) => (route === "localp/small" ? { url: model.url, headers: () => ({ authorization: "Bearer sk-provider-secret" }) } : undefined) });
          const parts = localWorkerParts<unknown>({
            launcher: real as never, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
            workspace: () => dirs,
            model: () => ({ alias: "m0", provider: "localp", api: "openai-completions", modelId: "local", contextWindow: 32_768, maxTokens: 1024, reasoning: false, input: ["text"] }),
            namespaceId: () => "abcdef0123456789",
            bridge: async () => ({ ok: true, result: {} }),
            relay: (order, request) => services.attemptRelay(order as never, relay, { model: "local" }).relay(request),
            context: (order) => services.context(order as never),
            requireEnforced: false, guestPaths: process.platform === "darwin" ? "host" : "private",
          });
          local = new LocalWorker({
            hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "c07g-test", guards: services.guards,
            sandbox: parts.sandbox as never, runtimes: { open: (order, call, from) => parts.runtimes.open(order as never, call, from as never) as never },
            capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }) as never,
          });
          const start = local.start.bind(local);
          local.start = async (order) => { orders.push(order); return start(order); };
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
    const call = (op: string, args: Record<string, unknown>, commandId?: string): Promise<Reply> => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" } } } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
    await local!.register(HostService.withEpoch(c.storage, c.epoch, s.assignments), hostP);
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: AGENT, grants: workGrants(project) });
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Water the beds" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: AGENT } });
    // The owner's record for the task: long open questions, then a goal and a decision in the owner's own words.
    const questions: string[] = [];
    // Each is short enough that it is either whole or left out (a one-line reference), never cut to a head and a tail.
    for (let i = 0; i < 40; i++) {
      const question = `Bed ${i}: ${"how much water does this bed need in a dry week, and at what time of day? ".repeat(7)}`.slice(0, 500);
      questions.push(question);
      assert.equal((await call("decision.ask", { taskId, topic: `bed-${i}`, question }, `q${i}`)).ok, true);
    }
    for (const [category, topic, wording] of [["goal", "harvest", "Goal: every bed gives a harvest this summer."], ["decision", "hose", "Use the soaker hose, never the sprinkler."]] as const) {
      const r = await call("decision.record", { projectId: project, category, topic, statement: wording, wording, basedOn: 0 }, `d-${topic}`);
      assert.equal(r.ok && r.result.recorded, true, JSON.stringify(r));
    }
    // The task last ran on the cloud route; the local route it goes to now has never been measured.
    await c.storage.applyOperation({ operationId: "op-placed", epoch: c.epoch, actor: owner.id, correlationId: "op-placed", at: new Date().toISOString(), changes: [{ type: "create", ref: { kind: "task-placement", id: taskId }, body: { hostId: "host:w1", route: "cloudp/big" } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    assert.equal((await c.storage.listAggregates("ctx-route-fixed", { limit: 10 })).length, 0, "nothing measured yet");
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;

    const report = await c.dispatch!.dispatcher.tick();
    assert.deepEqual(report.started, [attemptId]);
    await c.dispatch!.dispatcher.idle();
    const ended = (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))!;
    assert.equal(ended.outcome?.status, "succeeded", JSON.stringify(ended.outcome));

    // The dispatcher's order: the view built on the assumed figure, said to be unmeasured.
    const order = orders.find((o) => o.attemptId === attemptId)!;
    assert.equal(order.route, "localp/small");
    assert.deepEqual([order.startupView?.route, order.startupView?.measured], ["localp/small", false]);
    const assumedView = order.content.slice(order.content.length - order.startupView!.chars);
    assert.ok(assumedView.startsWith(`\n\n${HEADER}`));

    // The process was measured before its first call: the route's figure is the process's own (its system prompt, which is the completion rules of card W06, and the bridge tools' schemas), and the move was decided again on it.
    const fixed = (await c.storage.listAggregates("ctx-route-fixed", { limit: 10 })).map((x) => x.body as unknown as { route: string; samples: { systemPromptChars: number; toolSchemaChars: number; attemptId: string }[] });
    assert.equal(fixed.length, 1);
    const sample = fixed[0]!.samples.find((x) => x.attemptId === attemptId)!;
    assert.ok(sample.toolSchemaChars > 0 && sample.systemPromptChars === sharedSystemText(PI_AGENT_LAYOUT).length, JSON.stringify(sample));
    const moves = (await c.storage.listAggregates("ctx-admission", { limit: 50 })).map((x) => x.body as unknown as { type: string; attemptId: string; basis: string; admit: boolean; startupTokens: number }).filter((x) => x.type === "route-change" && x.attemptId === attemptId);
    assert.deepEqual(moves.map((m) => [m.basis, m.admit]).sort(), [["estimated", true], ["unmeasured", true]], "decided on the assumed figure, then again on the measured one");

    // What the model got is the view built on the measured figure: the process's tools are much smaller than the assumed 14,000 characters, so more of the owner's questions fit whole than in the dispatcher's view.
    assert.equal(model.seen.length, 2, "the first call, then the call after the agent ended its work");
    const sent = JSON.stringify(model.seen[0]!.body.messages);
    const text = JSON.parse(sent) as { content: unknown }[];
    const prompt = text.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    assert.ok(prompt.includes(HEADER), "the rebuilt view reached the model");
    assert.ok(prompt.includes("Goal: every bed gives a harvest this summer.") && prompt.includes("Use the soaker hose, never the sprinkler."), "the owner's goal and words whole");
    const wholeIn = (x: string): number => questions.filter((q) => x.includes(q)).length;
    assert.ok(sample.toolSchemaChars < 14_000, `the process's tools (${sample.toolSchemaChars} characters) are smaller than the assumed floor`);
    assert.ok(wholeIn(prompt) > wholeIn(assumedView), `more questions whole on the measured figure (${wholeIn(prompt)}) than on the assumed one (${wholeIn(assumedView)})`);
    assert.equal(prompt.includes(assumedView.slice(2)), false, "the assumed view was not sent");
    // Some still did not fit: each is named by the digest of its full text, which reads it back through the API.
    const digests = [...new Set([...prompt.matchAll(/sha256:[0-9a-f]{64}/g)].map((m) => m[0]))];
    assert.ok(wholeIn(prompt) < questions.length && digests.length > 0, "the window still cuts some questions");
    for (const digest of digests) {
      const back = await call("context.route-archive.read", { taskId, digest });
      assert.equal(back.ok, true, JSON.stringify(back));
      assert.ok(questions.some((q) => back.result.item.text.includes(q)), "the full question is read back");
    }
    // The first call that carried the view was admitted (the host counts a new conversation's store files at its first round, so that round may be refused for a retry and admitted after the store is compacted; no blocker either way).
    const first = (await c.storage.listAggregates("ctx-admission", { limit: 50 })).map((x) => x.body as unknown as { type: string; attemptId: string; admit: boolean; round: number }).filter((x) => x.type === "first-call" && x.attemptId === attemptId).sort((x, y) => x.round - y.round);
    assert.equal(first.at(-1)?.admit, true);
    const open = (await c.storage.listAggregates("blocker", { limit: 50 })).map((x) => x.body as unknown as { type: string; state?: string; status?: string });
    assert.equal(open.filter((b) => b.type === "context_overflow").length, 0, "no context blocker");
  } finally { model.server.closeAllConnections(); model.server.close(); await c.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
