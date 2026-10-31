import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AdmissionService, DifficultyService, GenerationService, HostService, LocalWorker, ModelRelay, PolicyService, startController, } from "@nimblenewt/controller";
import { EXEC_PROFILES, PI, ROUTING_TABLE, workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher, appFromRepository, localWorkerParts, type LaunchRecord } from "@nimblenewt/worker";
import { loopbackFetch, sse } from "./h12-worker-support.js";
import { descendantsOf, processesMentioning } from "./h12b-confinement-support.js";

// Card L05b through the composed controller (the rig is the one of H12b/H12f): startController builds the dispatcher and binds its services to the local worker's guards; the local worker host is the real one (the real bubblewrap launcher and the real worker process running
// Pi), the model is a scripted endpoint behind the controller's relay. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** Where the CI says the sandbox exists (NIMBLENEWT_REQUIRE_SANDBOX=1) a check that cannot run is a failure, never a silent skip. */
const skipOrFail = (t: { skip(why: string): void }, why: string): void => { if (required) assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the check cannot run: ${why}`); t.skip(why); };
const AGENT = "agt-abcdefghijklmnopqrst";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms = 30_000, why: string | (() => string) = "timed out waiting"): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(typeof why === "function" ? why() : why); await sleep(50); } };
const read = (pid: string, file: string): string => { try { return readFileSync(`/proc/${pid}/${file}`, "utf8"); } catch { return ""; } };

interface Step { readonly before?: string; readonly text?: string; readonly call?: { readonly name: string; readonly args: object }; readonly hold?: Promise<void> }
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
        res.write(sse({ role: "assistant", content: step.before ?? "" }, null));
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
/** Bubblewrap on Linux, Seatbelt on macOS (the host's own paths, no private view); no launcher is provided here for Windows (card A03b's remainder), so nothing runs there. */
const style = process.platform === "darwin" ? "host" as const : "private" as const;
async function launcher(): Promise<SandboxLauncher | undefined> {
  const real = await SandboxLauncher.create({ protectedPaths: [], audit: (r) => { records.push(r); } });
  const backend = process.platform === "darwin" ? "seatbelt" : "bubblewrap";
  const usable = real.capacity.available && real.capacity.backend === backend && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  if (!usable && required && (process.platform === "linux" || process.platform === "darwin")) assert.fail(`the sandbox is required but unusable: ${real.capacity.reason}`);
  return usable ? real : undefined;
}
const linuxOnly = process.platform === "linux" ? undefined : "this check reads the sandbox from the host's /proc and mount table (Linux), or runs a program at the private path /opt/node; the macOS and Windows proof is the remainder card of H12b";

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
        acceptUnenforcedLimits: true,
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
            requireEnforced: false, guestPaths: style,
            // The ledger's own view: work an earlier process left unsettled stays held until reviewed; nothing unsettled lets the restarted process carry on.
            heldForReview: (order) => c.dispatch!.dispatcher.heldForReview(order.attemptId),
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


describe("the model stream feeds revision-bound generation with the real worker process (card L05b)", () => {
  test("the owner corrects a task mid-generation: the earlier stream is held with a visible reason and never reaches the worker, and the next generation starts under the new revision", async (t) => {
    const real = await launcher();
    if (real === undefined) return skipOrFail(t, "the sandbox of this OS (bubblewrap, Seatbelt) or a node install it can mount is unusable");
    const first = gate();
    const answer = await model([{ before: "Plant the ", hold: first.promise, text: "TOMATOES" }, { text: "Plant the beans" }]);
    const x = await rig(real, answer);
    try {
      const { taskId, attemptId } = await x.task(1, "Order seeds");
      const generation = GenerationService.withEpoch(x.c.storage, x.c.epoch);
      const view = async (n: number) => (await generation.view(x.owner, GenerationService.runIdOf(taskId, n)))?.run;
      assert.deepEqual((await x.tick()).started, [attemptId]);
      await until(async () => (await view(1))?.text === "Plant the ", 30_000, "the first part of the stream was never recorded");
      assert.equal((await view(1))!.state, "streaming");
      assert.equal((await view(1))!.contextRevision, 1);
      assert.equal((await view(1))!.fence?.attemptId, attemptId, "the generation is bound to the attempt that streams it");

      // The owner corrects the task while the model is still writing; then the model finishes its (now stale) answer.
      await generation.correct(x.owner, { commandId: "fix", taskId, expectedContextRevision: 1, reason: "use beans, not tomatoes" });
      first.open();
      await until(async () => (await view(1))?.state === "interrupted" && (await view(1))!.late.some((l) => l.kind === "completion"), 30_000, "the late end of the earlier stream was never recorded");
      const earlier = (await view(1))!;
      assert.equal(earlier.interrupted?.kind, "corrected");
      assert.match(earlier.interrupted?.reason ?? "", /use beans/);
      assert.equal(earlier.text, "Plant the ", "what arrived after the correction was not applied");
      assert.ok(earlier.late.some((l) => l.kind === "text" && l.preview === "TOMATOES"), "the late text is visible, as a digest and a preview");

      // The worker's call failed with the reason (it was never given the late answer), and its next call began a generation under the new revision.
      await until(async () => (await view(2))?.state === "finished", 60_000, "the next generation never finished");
      const next = (await view(2))!;
      assert.equal(next.contextRevision, 2);
      assert.equal(next.text, "Plant the beans");
      assert.equal(requestText(answer, answer.seen.length - 1).includes("TOMATOES"), false, "the late answer is not in anything the model was later shown");
      await x.c.dispatch!.dispatcher.idle();
    } finally { first.open(); answer.server.closeAllConnections(); answer.server.close(); await x.close(); }
  });
});
