import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AdmissionService, BlockerService, DifficultyService, HostService, LocalWorker, ModelRelay, PolicyService, startController, type ToolGateway, type ToolResult, type WorkOrder } from "@nimblenewt/controller";
import { EXEC_PROFILES, PI, ROUTING_TABLE, workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher, appFromRepository, localWorkerParts, type LaunchRecord } from "@nimblenewt/worker";
import { loopbackFetch, sse } from "./h12-worker-support.js";
import { descendantsOf, processesMentioning } from "./h12b-confinement-support.js";

// Cards H12b and H12f through the composed controller: startController builds the dispatcher and binds its services to the local worker's guards; the local worker host is the real one (the real bubblewrap launcher and the real worker process running
// Pi), the model is a scripted endpoint behind the controller's relay. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENT = "agt-abcdefghijklmnopqrst";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms = 30_000, why = "timed out waiting"): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(why); await sleep(50); } };
const read = (pid: string, file: string): string => { try { return readFileSync(`/proc/${pid}/${file}`, "utf8"); } catch { return ""; } };

interface Step { readonly text?: string; readonly call?: { readonly name: string; readonly args: object }; readonly hold?: Promise<void> }
interface Model { readonly server: Server; readonly url: string; readonly seen: { readonly body: { messages: { role: string; content: unknown }[] } }[]; replies: Step[] }
/** A model endpoint that plays the given steps in order; a step with `hold` does not answer until it is released (the model call stays open). A caller that goes away is not answered. */
async function model(steps: Step[]): Promise<Model> {
  const seen: Model["seen"][number][] = [];
  const state = { steps, at: 0 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      const step = state.steps[Math.min(state.at++, state.steps.length - 1)]!;
      let gone = false;
      res.on("close", () => { gone = true; });
      void (async () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // The first bytes go out at once and the rest only when the step is released: the call is open meanwhile.
        res.write(sse({ role: "assistant", content: "" }, null));
        if (step.hold !== undefined) await step.hold;
        if (gone) return;
        const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
        if (step.call !== undefined) {
          res.write(sse({ tool_calls: [{ index: 0, id: `call_${state.at}`, type: "function", function: { name: step.call.name, arguments: JSON.stringify(step.call.args) } }] }, null));
          res.write(sse({}, "tool_calls", usage));
        } else {
          res.write(sse({ content: step.text ?? "done" }, null));
          res.write(sse({}, "stop", usage));
        }
        res.end("data: [DONE]\n\n");
      })();
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen, get replies() { return state.steps; }, set replies(v) { state.steps = v; } };
}
const gate = (): { promise: Promise<void>; open: () => void } => { let open!: () => void; const promise = new Promise<void>((r) => { open = r; }); return { promise, open }; };
/** How many messages wait for the agent, read through the API as the owner. */
const queued = async (x: Rig): Promise<number> => { const r = await x.c.api.handle(x.ownerToken, { v: 1, op: "message.inbox", args: { recipient: `agent:${AGENT}` } } as never) as { ok: boolean; result?: { item?: { items: unknown[] } }; error?: unknown }; assert.equal(r.ok, true, JSON.stringify(r)); return r.result?.item?.items.length ?? 0; };
const requestText = (m: Model, at: number): string => JSON.stringify(m.seen[at]?.body.messages ?? []);

const records: LaunchRecord[] = [];
async function launcher(): Promise<SandboxLauncher | undefined> {
  const real = await SandboxLauncher.create({ protectedPaths: [], audit: (r) => { records.push(r); } });
  const usable = real.capacity.available && real.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  if (!usable && required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${real.capacity.reason}`);
  return usable ? real : undefined;
}

interface Rig {
  readonly c: Awaited<ReturnType<typeof startController>>;
  readonly owner: Awaited<ReturnType<Awaited<ReturnType<typeof startController>>["services"]["principals"]["authenticate"]>>;
  readonly ownerToken: string;
  readonly project: string;
  readonly directory: string;
  readonly dirsOf: (agent: string) => { checkout: string; gitDir: string; home: string; scratch: string };
  readonly worker: () => LocalWorker;
  readonly tick: () => Promise<{ started: string[] }>;
  readonly task: (n: number, title: string) => Promise<{ taskId: string; attemptId: string }>;
  readonly inputs: string;
  readonly window: { value: number };
  close(): Promise<void>;
}

/** The composed controller with the real local worker host, the owner, the host registered and the routing the dispatcher needs. */
async function rig(real: SandboxLauncher, answer: Model): Promise<Rig> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn h12bf ")));
  const inputs = join(directory, "inputs-a");
  mkdirSync(inputs);
  writeFileSync(join(inputs, "note.txt"), "readable input\n");
  const dirsOf = (agent: string) => {
    const base = join(directory, "agents", agent.replace(/[^A-Za-z0-9-]/g, "_"));
    const dirs = { checkout: join(base, "checkout"), gitDir: join(base, "git"), home: join(base, "home"), scratch: join(base, "scratch") };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    return dirs;
  };
  const window = { value: 32768 };
  let local: LocalWorker | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(directory, "c.sqlite") }, argv: [], env: {}, print: () => undefined,
    facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [PI],
    dispatch: {
      manual: true,
      local: {
        window: () => window.value,
        build: (services) => {
          const relay = new ModelRelay({ fetch: loopbackFetch, endpoint: (route) => (route === "localp/small" ? { url: answer.url, headers: () => ({ authorization: "Bearer sk-provider-secret" }) } : undefined) });
          const parts = localWorkerParts<unknown>({
            launcher: real as never, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
            workspace: (order) => dirsOf(order.agentId),
            model: () => ({ alias: "m0", provider: "localp", api: "openai-completions", modelId: "local", contextWindow: window.value, maxTokens: 1024, reasoning: false, input: ["text"] }),
            namespaceId: () => "abcdef0123456789",
            bridge: async () => ({ ok: true, result: { record: { id: "dsk-aaaaaaaaaaaaaaaaaaaa", body: "x" } } }),
            relay: (order, request) => services.attemptRelay(order as never, relay, { model: "local" }).relay(request),
            context: (order) => services.context(order as never),
            reach: (name) => (name === "inputs-a" ? { readOnly: [{ host: inputs, guest: "/inputs/a" }] } : undefined),
            requireEnforced: false,
          });
          local = new LocalWorker({
            hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "h12bf-test", guards: services.guards,
            schedule: (beat) => { const timer = setInterval(() => { void beat(); }, 100); return () => clearInterval(timer); },
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
  await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" } } } as never);
  await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
  await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
  const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
  await local!.register(HostService.withEpoch(c.storage, c.epoch, s.assignments), hostP);
  await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
  await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
  const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
  await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: AGENT, grants: [...workGrants(project), { action: "message.receive", project }] });
  const task = async (n: number, title: string) => {
    const taskId = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title })).id;
    await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
    return { taskId, attemptId };
  };
  return { c, owner, ownerToken: boot.token, project, directory, dirsOf, worker: () => local!, tick: async () => c.dispatch!.dispatcher.tick() as never, task, inputs, window, close: async () => { await c.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
}

/** The processes of the attempt's worker (inside the sandbox), found from the host's /proc by the attempt's home directory, which the launcher names on the sandbox's command line. */
const workerPids = (directory: string): string[] => descendantsOf(processesMentioning(directory).map((p) => p.pid)).filter((p) => p.comm !== "bwrap").map((p) => p.pid);
const mountPoints = (pid: string): string[] => read(pid, "mountinfo").split("\n").filter((l) => l !== "").map((l) => l.split(" ")[4]!);

describe("the composed controller runs the real worker process (cards H12b, H12f)", () => {
  test("a pause that arrives mid-turn shows as pausing while the model call is open and as paused once it has settled; an interrupt reaches the running attempt and never a paused one; the provider's count of the first call is recorded", async (t) => {
    const real = await launcher();
    if (real === undefined) return t.skip("bubblewrap or a node install it can mount is unusable");
    const first = gate();
    const answer = await model([{ hold: first.promise, call: { name: "nimblenewt__desk-read", args: { recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" } } }, { text: "all done" }]);
    const x = await rig(real, answer);
    try {
      const { taskId, attemptId } = await x.task(1, "Order seeds");
      const state = async () => (await x.c.dispatch!.dispatcher.get(x.c.dispatch!.principal, attemptId))!;
      const gateOf = async () => (await x.c.services.pauses.gate(x.owner, { kind: "task", id: taskId }))!;
      const report = await x.tick();
      assert.deepEqual(report.started, [attemptId]);
      await until(() => answer.seen.length === 1, 30_000, "the model call never arrived");
      // The first call was admitted (C07b) before it went out; the provider's count of it is recorded once the reply has begun.
      const admissions = await x.c.storage.listAggregates("ctx-admission", { limit: 10 });
      assert.equal(admissions.length, 1, "the first call was checked at start");
      assert.equal((admissions[0]!.body as unknown as { admit: boolean }).admit, true);

      // An urgent message from the owner reaches the running attempt while its model call is open (an interrupt needs no safe boundary).
      const told = await x.c.api.handle(x.ownerToken, { v: 1, op: "message.send", commandId: "m1", args: { taskId, to: `agent:${AGENT}`, class: "urgent-control", purpose: "safety", text: "stop writing to the shared folder" } } as never) as { ok: boolean };
      assert.equal(told.ok, true, JSON.stringify(told));
      await until(async () => (await queued(x)) === 0, 20_000, "the interrupt was never delivered");

      // The owner pauses the task while the model call is still open: the honest state is pausing (set by the runtime, not just requested).
      await x.c.services.pauses.pause(x.owner, { commandId: "pz1", scope: { kind: "task", id: taskId }, reason: "look at it" });
      await until(async () => (await gateOf()).observed?.by === `agent:${AGENT}`, 20_000, "the runtime never reported");
      assert.equal((await gateOf()).observed?.state, "pausing");
      await sleep(400);
      assert.equal((await gateOf()).observed?.state, "pausing", "a model call is open, so it is not paused yet");
      // A second interrupt while paused is not delivered.
      await x.c.api.handle(x.ownerToken, { v: 1, op: "message.send", commandId: "m2", args: { taskId, to: `agent:${AGENT}`, class: "urgent-control", purpose: "safety", text: "second thing" } } as never);
      await sleep(500);
      assert.equal(await queued(x), 1, "nothing reaches a paused attempt: the message is still queued");

      // The call settles; the turn goes on to its end and the attempt is reported paused with the safe-boundary statement.
      first.open();
      await x.c.dispatch!.dispatcher.idle();
      const gate2 = await gateOf();
      assert.equal(gate2.observed?.state, "paused");
      assert.equal(gate2.observed?.boundary, "finished");
      assert.equal((await state()).state, "finished");
      // The model saw the first interrupt on its next call, as another party's words from the owner; never the second.
      assert.equal(answer.seen.length >= 2, true);
      assert.match(requestText(answer, 1), /stop writing to the shared folder/);
      assert.match(requestText(answer, 1), /from the owner/);
      assert.equal(requestText(answer, answer.seen.length - 1).includes("second thing"), false);
      // The provider's count of the first call was recorded against the admission that let it go (C07b confirmUsage, end to end).
      await until(async () => (await x.c.storage.listAggregates("ctx-admission", { limit: 10 })).some((a) => (a.body as unknown as { reported?: { inputTokens: number } }).reported?.inputTokens === 10), 10_000, "the provider's count was never recorded");
    } finally { answer.server.closeAllConnections(); answer.server.close(); await x.close(); }
  });

  test("a stored conversation over the startup share is compacted once by the real process and then admitted; one that cannot fit is refused at start with the blocker, and nothing was sent to the model", async (t) => {
    const real = await launcher();
    if (real === undefined) return t.skip("bubblewrap or a node install it can mount is unusable");
    const big = (n: number): string => `Seed order part ${n}. `.concat("The seed order is long and detailed. ".repeat(330));
    const answer = await model([{ text: big(1) }, { text: big(2) }, { text: "continued" }]);
    const x = await rig(real, answer);
    x.window.value = 32768;
    try {
      const { taskId, attemptId } = await x.task(1, "Order seeds");
      const gateway = { attemptId, call: async (): Promise<ToolResult> => { throw new Error("not used"); }, heartbeat: async () => ({ until: new Date(Date.now() + 600_000).toISOString() }), usage: async () => undefined, acknowledgeDecisions: async () => undefined } as unknown as ToolGateway;
      const order = (n: number, id: string, resumeFrom?: object): WorkOrder => ({ attemptId: id, taskId, projectId: x.project, agentId: `agent:${AGENT}`, generation: 1, route: "localp/small", credential: `cred-${n}`, recipe: { revision: "r1", reach: [] }, content: "go on", requestId: `req-${n}`, expiresAt: new Date(Date.now() + 300_000).toISOString(), ...(resumeFrom === undefined ? {} : { resumeFrom }) } as never);
      const sizeOf = (r: { checkpoint?: unknown }): number => (r.checkpoint as { nn?: { contextTokens?: number } }).nn?.contextTokens ?? 0;
      const run = async (n: number, id: string, from?: object) => { const handle = await x.worker().start(order(n, id, from)); const result = await handle.run(gateway); await handle.stop(); return result; };
      // Two attempts each add a long answer to the conversation stored in the agent's home. Each first call fits (a quarter of the window is 8,192 tokens), so neither is compacted.
      const one = await run(1, "att-one");
      assert.equal(one.status, "completed", one.error);
      const two = await run(2, "att-two", one.checkpoint);
      assert.equal(two.status, "completed", two.error);
      const stored = sizeOf(two);
      assert.ok(stored > 6000 && stored < 19000, `the stored conversation is over most of the startup share but under the resume share (${stored})`);
      // The third resumes it: the first call (the stored conversation plus the fixed part) is over the startup share, so it is refused (a retry is announced, so no blocker yet), the real process compacts, and the call is admitted. It runs.
      const three = await run(3, "att-three", two.checkpoint);
      assert.equal(three.status, "completed", three.error);
      const rounds = (await x.c.storage.listAggregates("ctx-admission", { limit: 20 })).map((a) => a.body as unknown as { attemptId: string; round: number; admit: boolean }).filter((b) => b.attemptId === "att-three").sort((a, b) => a.round - b.round);
      assert.deepEqual(rounds.map((r) => [r.round, r.admit]), [[1, false], [2, true]], "refused for size, compacted, admitted");
      const open = (await BlockerService.withEpoch(x.c.storage, x.c.epoch).list({ limit: 50, openOnly: true })).items;
      assert.equal(open.filter((b) => b.type === "context_overflow").length, 0, "a call that passed after compaction opens no blocker");
      assert.match(requestText(answer, 2), /Extract of/, "what the model got is the extract of the older part");
      assert.ok(requestText(answer, 2).length < requestText(answer, 1).length + 12000, "and not the whole stored conversation again");

      // A call that no compaction can bring under the limit is refused at start: the attempt ends failed, the blocker is open, and the model is not called.
      x.window.value = 1024;
      const calls = answer.seen.length;
      const refused = await run(4, "att-four", three.checkpoint);
      assert.equal(refused.status, "failed");
      assert.match(refused.error ?? "", /first call was not sent/);
      assert.equal(answer.seen.length, calls, "nothing was sent to the model");
      const after = (await BlockerService.withEpoch(x.c.storage, x.c.epoch).list({ limit: 50, openOnly: true })).items;
      assert.equal(after.filter((b) => b.type === "context_overflow").length, 1, "the refusal opened the blocker the owner sees");
    } finally { answer.server.closeAllConnections(); answer.server.close(); await x.close(); }
  });

  test("a recipe change on a running attempt is applied by the real launcher: widening adds a mount and limits, narrowing removes them, the turn and its conversation go on in the new process, the agent is told on a widening, and the turn keeps one number", async (t) => {
    const real = await launcher();
    if (real === undefined) return t.skip("bubblewrap or a node install it can mount is unusable");
    const g1 = gate(), g2 = gate(), g3 = gate();
    const answer = await model([{ hold: g1.promise, text: "never sent" }, { hold: g2.promise, call: { name: "nimblenewt__desk-read", args: { recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" } } }, { hold: g3.promise, text: "never sent" }, { text: "all done after two restarts" }]);
    const x = await rig(real, answer);
    try {
      const { attemptId } = await x.task(1, "Order seeds");
      const dirs = x.dirsOf(`agent:${AGENT}`);
      const dispatcher = x.c.dispatch!.dispatcher;
      const insideNow = (): string[] => workerPids(dirs.home.split("/").slice(0, -1).join("/"));
      const mounts = (): string[] => insideNow().flatMap((pid) => mountPoints(pid));
      await x.tick();
      await until(() => answer.seen.length === 1, 30_000, "the first model call never arrived");
      await until(() => insideNow().length > 0, 20_000, "the worker process never appeared");
      assert.equal(mounts().includes("/inputs/a"), false, "the first recipe has no such input");
      const firstPids = insideNow();

      // Widening, in the middle of the turn (the model call is open): the sandbox is started again with the input mounted and the stated limits, the agent is told.
      const wide = await dispatcher.changeRecipe(x.owner, attemptId, { kind: "widen", recipe: { revision: "r-wide", reach: ["inputs-a"], limits: { memoryMb: 768, processes: 64 } }, tell: "You can now read /inputs/a." });
      assert.equal(wide.restarted, true);
      await until(() => answer.seen.length >= 2, 30_000, "the turn did not go on in the new process");
      await until(() => mounts().includes("/inputs/a"), 20_000, "the widened recipe's mount is not there");
      const widePids = insideNow();
      assert.ok(widePids.every((p) => !firstPids.includes(p)), "a new process, not the old one");
      assert.ok(mounts().includes("/inputs/a") && mounts().includes("/work"), "the checkout is still mounted");
      const limits = records.at(-1)?.limits ?? [];
      assert.deepEqual(limits.map((l) => [l.limit, l.value]).sort(), [["memoryMb", 768], ["processes", 64]], "the launch record names the limits of the recipe it was started with");
      // The conversation survived: the resumed turn's call carries the task's first message, under the same request.
      assert.match(requestText(answer, 1), /Order seeds/);

      // The call settles with a tool call; the call after it carries what the agent was told.
      g2.open();
      await until(() => answer.seen.length >= 3, 30_000, "the turn did not go on");
      assert.match(requestText(answer, 2), /You can now read \/inputs\/a\./, "the agent was told of the widening");
      assert.match(requestText(answer, 2), /Order seeds/);

      // Narrowing, in the middle of the next call: the mount and the limits go with the process that had them.
      const narrow = await dispatcher.changeRecipe(x.owner, attemptId, { kind: "narrow", recipe: { revision: "r-narrow", reach: [] } });
      assert.equal(narrow.restarted, true);
      await until(() => answer.seen.length >= 4, 30_000, "the turn did not go on after the narrowing");
      await until(() => !mounts().includes("/inputs/a") && insideNow().length > 0, 20_000, "the narrowed recipe still has the mount");
      assert.ok(insideNow().every((p) => !widePids.includes(p)));
      assert.deepEqual(records.at(-1)?.limits ?? [], [], "no limits asked for, none recorded");
      assert.match(requestText(answer, 3), /You can now read \/inputs\/a\./, "what the agent was told is still in its conversation");
      assert.match(requestText(answer, 3), /Order seeds/);
      const revisions = records.slice(-3).map((r) => r.recipeRevision);
      assert.notEqual(revisions[0], revisions[1], "the widened launch recorded another recipe revision");
      assert.equal(revisions[0], revisions[2], "the narrowed recipe is the first one again, so it has the first one's revision");

      await dispatcher.idle();
      const record = (await dispatcher.get(x.c.dispatch!.principal, attemptId))!;
      assert.equal(record.state, "finished");
      assert.equal(record.outcome?.status, "succeeded", JSON.stringify(record.outcome));
      assert.equal(record.recipeRevision, "r-narrow");
      // The hold steps that were never released belong to processes that were ended, not waited for.
      g1.open(); g3.open();
    } finally { answer.server.closeAllConnections(); answer.server.close(); await x.close(); }
  });

  test("from inside the sandbox nothing but the relay's address can be reached: the model endpoint, loopback and an outside address all fail", async (t) => {
    const real = await launcher();
    if (real === undefined) return t.skip("bubblewrap or a node install it can mount is unusable");
    const answer = await model([{ text: "x" }]);
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn h12bn ")));
    try {
      const dirs = { checkout: join(directory, "checkout"), home: join(directory, "home"), scratch: join(directory, "scratch") };
      for (const d of Object.values(dirs)) mkdirSync(d);
      const port = new URL(answer.url).port;
      const probe = `
        const net = require("node:net");
        const tryTo = (host, port) => new Promise((ok) => { const s = net.connect({ host, port, timeout: 3000 }); s.on("connect", () => { s.destroy(); ok(host + ":" + port + " CONNECTED"); }); s.on("error", (e) => ok(host + ":" + port + " " + e.code)); s.on("timeout", () => { s.destroy(); ok(host + ":" + port + " TIMEOUT"); }); });
        Promise.all([tryTo("127.0.0.1", ${port}), tryTo("93.184.216.34", 80), tryTo("10.0.0.1", 80)]).then((r) => console.log(r.join("\\n")));`;
      const run = await real.launch({ recipe: { mode: "sandboxed", workdir: dirs.checkout, home: dirs.home, scratch: dirs.scratch, readOnly: [{ host: nodeRoot, guest: "/opt/node" }], network: "none", env: {}, protectedSubpaths: [".git"] }, command: ["/opt/node/bin/node", "-e", probe], timeoutMs: 30_000, maxOutputBytes: 65_536 });
      const result = await run.result;
      assert.equal(result.exitCode, 0, result.stderr);
      const lines = result.stdout.trim().split("\n");
      assert.equal(lines.length, 3);
      for (const line of lines) assert.doesNotMatch(line, /CONNECTED/, `a destination was reachable from the sandbox: ${line}`);
      assert.equal(answer.seen.length, 0, "the endpoint was never reached from inside");
    } finally { answer.server.closeAllConnections(); answer.server.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

void readdirSync;
