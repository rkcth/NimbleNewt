import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AdmissionService, DifficultyService, HostService, LocalWorker, ModelRelay, PolicyService, startController } from "@nimblenewt/controller";
import { EXEC_PROFILES, LlamaSim, PI, ROUTING_TABLE, simulatedFetch, workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher, appFromRepository, localWorkerParts } from "@nimblenewt/worker";

// Card H12e through the composed controller: startController builds the cache policies (`dispatch.cache`), the operator's local build hands the attempt's policy to the relay and its `takeUsage` to the host, the real worker
// process runs Pi in the real sandbox, and its model calls reach the simulated llama-server of C06 through the relay. What the server reports as cache hits is what budget accounting records, per task and per project.
// Linux only (bubblewrap); on Linux it is skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI), where an unusable sandbox fails. The macOS and Windows proof of the worker process is the remainder card of H12b.
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ANN = "agt-aaaaaaaaaaaaaaaaaaaa", BOB = "agt-bbbbbbbbbbbbbbbbbbbb";
const LLAMA = "http://llama.test:8080";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function launcher(): Promise<SandboxLauncher | undefined> {
  const real = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = process.platform === "linux" && real.capacity.available && real.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  if (!usable && required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${real.capacity.reason}`);
  return usable ? real : undefined;
}

/** What the simulated server answered, call by call, with the slot and cache setting it was asked for. */
interface Answer { readonly slot: unknown; readonly cachePrompt: unknown; readonly cached: number; readonly computed: number }

test("the composed controller with the real worker process: a project reuses its slot, another project does not, and the server's hit figures are what budget accounting records (card H12e)", async (t) => {
  const real = await launcher();
  if (real === undefined) { t.skip("this rig runs on Linux with bubblewrap and a node install it can mount"); return; }
  const sim = new LlamaSim(2);
  const answers: Answer[] = [];
  const recording = { send: async (r: Parameters<LlamaSim["send"]>[0]) => {
    const a = await sim.send(r);
    if (r.path === "/v1/chat/completions" && a.status === 200) { const timings = (a.body as { timings: { cache_n: number; prompt_n: number } }).timings; answers.push({ slot: r.body["id_slot"], cachePrompt: r.body["cache_prompt"], cached: timings.cache_n, computed: timings.prompt_n }); }
    return a;
  } };
  // A crash in the middle of a turn, after a real model call: the model asks for a tool and the process is killed while the tool runs.
  const crash = { armed: false, asked: false };
  const runs: { kill(): void }[] = [];
  const tapped = { launch: async (request: Parameters<SandboxLauncher["launch"]>[0]) => { const run = await real.launch(request); runs.push(run); return run; } };
  const plain = simulatedFetch(recording);
  const endpointFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await plain(input, init);
    if (!/event-stream/.test(response.headers.get("content-type") ?? "")) return response;
    // Card W03: an agent's turn is done when it ends with work.end. The first call of each turn (no tool result in it yet) is answered with that call, keeping the server's figures; the call after it gets the server's text.
    const opening = !(JSON.parse(typeof init?.body === "string" ? init.body : Buffer.from(init?.body as Buffer).toString("utf8")) as { messages: { role: string }[] }).messages.some((m) => m.role === "tool");
    if (!crash.armed && !opening) return response;
    const events = (await response.text()).split("\n\n").filter((e) => e.startsWith("data: {")).map((e) => JSON.parse(e.slice(6)) as Record<string, unknown>);
    if (crash.armed) crash.asked = true;
    const call = crash.armed ? { index: 0, id: "call_1", type: "function", function: { name: "nimblenewt__desk-read", arguments: JSON.stringify({ recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" }) } }
      : { index: 0, id: "call_end", type: "function", function: { name: "nimblenewt__work-end", arguments: JSON.stringify({ report: "Done as the task asked.", result: "done", note: "seeds ordered" }) } };
    const out = [{ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] } }] }, { ...events.at(-1), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }];
    return new Response(`${out.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn h12e ")));
  let local: LocalWorker | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(directory, "c.sqlite") }, argv: [], env: {}, print: () => undefined,
    facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [PI],
    dispatch: {
      manual: true,
      // No endpoint state is given: the composer keeps the controller's own.
      cache: { secret: "installation-secret-0123456789", endpoints: { "localp/small": { url: LLAMA, config: { kind: "llama-cpp", model: "local", route: "localp/small", options: { slots: 2 } } } } },
      local: {
        acceptUnenforcedLimits: true,
        window: () => 32768,
        build: (services) => {
          assert.ok(services.cache !== undefined, "the composer hands the host the cache policies");
          const relay = new ModelRelay({ fetch: endpointFetch, endpoint: (route) => (route === "localp/small" ? { url: `${LLAMA}/v1`, headers: () => ({ authorization: "Bearer local" }) } : undefined) });
          const parts = localWorkerParts<unknown>({
            launcher: tapped as never, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
            workspace: (order) => {
              const base = join(directory, "agents", order.attemptId);
              const dirs = { checkout: join(base, "checkout"), gitDir: join(base, "git"), home: join(base, "home"), scratch: join(base, "scratch") };
              for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
              return dirs;
            },
            model: () => ({ alias: "m0", provider: "localp", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] }),
            namespaceId: () => "abcdef0123456789",
            bridge: async () => { if (crash.asked) runs.at(-1)!.kill(); return { ok: true, result: { record: { id: "dsk-aaaaaaaaaaaaaaaaaaaa", body: "x" } } }; },
            // The operator's wiring the composer documents: the attempt's one policy goes to the relay, and its key, retention and figures to the host.
            relay: async (order, request) => { const attempt = await services.cache!.forOrder(order as never); return services.attemptRelay(order as never, relay, { model: "local", cache: attempt.policy }).relay(request); },
            cache: async (order) => { const attempt = await services.cache!.forOrder(order as never); return { ...(attempt.policy.key === undefined ? {} : { key: attempt.policy.key }), ...(attempt.policy.retention === undefined ? {} : { retention: attempt.policy.retention }), takeUsage: () => attempt.takeUsage() }; },
            context: (order) => services.context(order as never),
            requireEnforced: false, guestPaths: "private",
            heldForReview: (order) => c.dispatch!.dispatcher.heldForReview(order.attemptId),
          });
          local = new LocalWorker({
            hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "h12e-test", guards: services.guards,
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
    const ownerToken = (await s.principals.bootstrapOwner({ name: "rob" })).token;
    const owner = await s.principals.authenticate(ownerToken);
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" } } } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
    await local!.register(HostService.withEpoch(c.storage, c.epoch, s.assignments), hostP);
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const garden = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const kitchen = (await s.projects.createProject({ commandId: "p2", actor: owner.id, name: "Kitchen" })).id;
    // One agent works in both projects, so the prompts of the two projects are the same apart from the task: only the slot partitioning keeps a project from reading the other's cache.
    await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: ANN, grants: [...workGrants(garden), ...workGrants(kitchen)] });
    await s.principals.enroll(owner, { commandId: "e-bob", kind: "agent", name: BOB, grants: workGrants(garden) });
    let n = 0;
    /** Creates a task, admits its attempt, runs it to the end on the real worker and returns what the server answered for it. */
    const run = async (projectId: string, agent: string, title: string, status = "succeeded"): Promise<{ taskId: string; answers: Answer[] }> => {
      n += 1;
      const taskId = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId, title })).id;
      await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
      await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId, owner: { kind: "agent", id: agent } });
      const a = (await s.assignments.getAssignment(taskId))!;
      const attemptId = (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
      const from = answers.length;
      const tick = await c.dispatch!.dispatcher.tick();
      assert.deepEqual(tick.started, [attemptId], JSON.stringify({ ...tick, loops: undefined }));
      const end = Date.now() + 60_000;
      for (;;) {
        const d = await c.dispatch!.dispatcher.get(owner, attemptId);
        if (d?.state === "finished") { assert.equal(d.outcome?.status, status, JSON.stringify(d.outcome)); assert.equal(d.usageError, undefined, "the turn's figures were charged"); break; }
        if (Date.now() > end) assert.fail(`attempt ${attemptId} did not finish: ${JSON.stringify(d)}`);
        await sleep(50);
      }
      await c.dispatch!.dispatcher.idle();
      return { taskId, answers: answers.slice(from) };
    };
    // Read as the owner reads it, through the API.
    const charged = async (filter: { taskId?: string; projectId?: string }) => {
      const r = await c.api.handle(ownerToken, { v: 1, op: "budget.usage", args: filter } as never) as { ok: boolean; result?: { item: { cacheByBackend: Record<string, unknown> } } };
      assert.equal(r.ok, true, JSON.stringify(r));
      return r.result!.item.cacheByBackend["llama-cpp"];
    };
    const sum = (list: Answer[]) => ({ cachedTokens: list.reduce((x, a) => x + a.cached, 0), computedTokens: list.reduce((x, a) => x + a.computed, 0), writtenTokens: 0 });

    const first = await run(garden, ANN, "Order seeds");
    const second = await run(garden, BOB, "Order seeds");
    const other = await run(kitchen, ANN, "Order seeds");
    for (const r of [first, second, other]) assert.ok(r.answers.length >= 1, "the task's model calls reached the server");
    // Not the degraded mode: every call named its project's slot and asked for reuse.
    assert.ok([...first.answers, ...second.answers, ...other.answers].every((a) => typeof a.slot === "number" && a.cachePrompt === true), JSON.stringify(answers));
    const gardenSlot = first.answers[0]!.slot;
    assert.ok(second.answers.every((a) => a.slot === gardenSlot), "a project's agents share its slot");
    assert.ok(other.answers.every((a) => a.slot !== gardenSlot), "another project gets its own slot");
    assert.ok(sum(second.answers).cachedTokens > 0, `the project's second task reads the shared head from the slot (${JSON.stringify(second.answers)})`);
    // Its first call: the call after the agent's work.end reads that task's own head from its own slot.
    assert.equal(other.answers[0]!.cached, 0, "the other project reads nothing, though its prompt is the same apart from the task");

    // What the server reported is what accounting has: per task (one usage report per turn), and per project.
    for (const r of [first, second, other]) assert.deepEqual(await charged({ taskId: r.taskId }), { ...sum(r.answers), calls: 1 }, `task ${r.taskId}`);
    assert.deepEqual(await charged({ projectId: garden }), { ...sum([...first.answers, ...second.answers]), calls: 2 });
    assert.deepEqual(await charged({ projectId: kitchen }), { ...sum(other.answers), calls: 1 });

    // The worker process dies in the middle of a turn, after its model call was answered from the project's slot: the attempt fails, and the hit the server reported is still recorded for the task.
    crash.armed = true;
    const crashed = await run(garden, ANN, "Order seeds", "failed");
    crash.armed = false;
    assert.equal(crash.asked, true, "the process was killed while the tool the model asked for ran");
    assert.ok(crashed.answers.length >= 1 && sum(crashed.answers).cachedTokens > 0, JSON.stringify(crashed.answers));
    assert.deepEqual(await charged({ taskId: crashed.taskId }), { ...sum(crashed.answers), calls: 1 }, "the failed turn's figures are not lost");
  } finally { await c.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
