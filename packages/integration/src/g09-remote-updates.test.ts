import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AdmissionService, LocalWorker, ModelRelay, RemoteOfferRunner, RemoteWorkerClient, startController, type WorkOrder } from "@nimblenewt/controller";
import { PI, workGrants } from "@nimblenewt/controller/testing";
import { appFromRepository, localWorkerParts } from "@nimblenewt/worker";
import { loopbackFetch } from "./h12-worker-support.js";
import { model, sandbox } from "./w03-rig-support.js";

// Card G09 on a REMOTE worker host: the delivery of an updated resume through production code end to end, as `g09-retained-context.test.ts` proves it for the local host. The composed controller (SQLite) and its
// dispatcher offer the attempt over the worker protocol (HTTP) to a `RemoteOfferRunner` whose host is the worker package's launcher and the real worker process (Pi Durable) in its bubblewrap sandbox, behind a `LocalWorker`.
// A side line of work selects the owner's decision, the owner corrects it, the correction is selected and the side line returns: the next offer carries the correction, and the remote machine's process places it before the
// turn, once, with where it came from; the superseded decision is not given; a later run on the same conversation does not place it again. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI). No real model.
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENT = "agt-remoteupdatesgivenon";
const ABILITIES = { formats: [1], features: ["limits", "wall-time"], enforces: { cpus: "full", memoryMb: "full", diskMb: "full", processes: "full", wallTimeMs: "full" } };
const WINDOW = 36864;

test("an updated resume on a remote worker host: the offer carries the selected correction, the machine's process places it once before the turn with its provenance, and a later run does not place it again (card G09)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  // Each run is one reply without work.end: the machine's tool bridge here answers no request, so the process asks for no nudged continuation (card W04) and the attempt goes on in the same conversation at the next run.
  const answer = await model([{ text: "started on plan A" }, { text: "switching to plan B" }, { text: "still on plan B" }]);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn g09r ")));
  const c = await startController({
    storage: { kind: "sqlite", path: join(directory, "c.sqlite") }, argv: [], env: {}, print: () => undefined,
    facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [PI],
    dispatch: {
      manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } }),
      remote: {
        workspaceAdmission: async () => [], blobDirectory: join(directory, "blobs"), relocationPolicy: async () => ({}), placementPolicy: async () => ({ dataHosts: ["host:r1"] }),
        hosts: [{ hostId: "host:r1", window: () => WINDOW, checkpointWaitMs: 5_000, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "local-only" as const, harness: "pi" }) }],
      },
    },
  });
  let runner: RemoteOfferRunner | undefined;
  try {
    assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
    const s = c.services;
    const owner = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    // The task's agent keeps the project's desk records and side chats; it is given what it may read, as itself.
    await s.principals.enroll(owner, { commandId: "e-agent", kind: "agent", name: AGENT, grants: [...workGrants(project), { action: "desk.read", project }, { action: "desk.write", project }, { action: "history.*", project }] as never });
    const ann = await s.principals.authenticate((await s.principals.issueCredential(owner, `agent:${AGENT}`)).token);
    await s.principals.enroll(owner, { commandId: "e-r1", kind: "host", name: "r1", grants: [] });
    const hostToken = (await s.principals.issueCredential(owner, "host:r1")).token;
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:r1", capacity: { cpus: 8, memoryMb: 16_384 } });
    const client = new RemoteWorkerClient({ url: c.dispatch.workerUrl!, token: hostToken, workerVersion: "worker-9.1.0" });
    await client.connect({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } as never);
    await client.heartbeat(1);
    const modelRelay = new ModelRelay({ fetch: loopbackFetch, endpoint: (route) => (route === "localp/small" ? { url: answer.url, headers: () => ({ authorization: "Bearer sk-provider-secret" }) } : undefined) });
    // The same directories for every run of the attempt: the remote machine keeps the agent's conversation store between its processes.
    const dirs = (order: WorkOrder) => {
      const base = join(directory, "attempts", order.attemptId);
      const made = { checkout: join(base, "checkout"), gitDir: join(base, "git"), home: join(base, "home"), scratch: join(base, "scratch") };
      for (const d of Object.values(made)) mkdirSync(d, { recursive: true });
      return made;
    };
    // The remote machine's parts: no `context` option (it has none of the controller's records); the updates come only with the order it is offered.
    const parts = localWorkerParts<unknown>({
      launcher: launcher as never, app: appFromRepository(repository, { root: nodeRoot, executable: "bin/node" }), protectedPaths: [],
      workspace: (order) => dirs(order as never),
      model: () => ({ alias: "m0", provider: "localp", api: "openai-completions", modelId: "local", contextWindow: WINDOW, maxTokens: 1024, reasoning: false, input: ["text"] }),
      namespaceId: () => "abcdef0123456789",
      bridge: async () => ({ ok: false, code: "invalid_command", message: "no tool call is made in this test" }) as never,
      relay: (order, request) => modelRelay.forAttempt({ route: "localp/small", model: "local", stream: runner!.tap((order as unknown as WorkOrder).attemptId) }).relay(request),
      requireEnforced: false,
    });
    const local = new LocalWorker({
      hostId: "host:r1", resources: { cpus: 1, memoryMb: 1024 }, version: "g09r-test",
      schedule: (beat) => { const timer = setInterval(() => { void beat(); }, 100); return () => clearInterval(timer); },
      sandbox: parts.sandbox as never, runtimes: { open: (order, call, from) => parts.runtimes.open(order as never, call as never, from as never) as never },
      capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }) as never,
    });
    runner = new RemoteOfferRunner({ client, host: local, abilities: ABILITIES as never, controlMs: 100, stream: { batchMs: 0, batchChars: 0 } });

    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Plant the garden" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
    const get = async () => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))!;
    const seenPlacements = new Set<number>();
    // One run: the dispatcher offers the attempt, the remote machine takes the offer and runs it to its end, and the dispatcher takes the result.
    const runOnce = async (): Promise<WorkOrder> => {
      await c.dispatch!.dispatcher.tick();
      let offer: Awaited<ReturnType<typeof client.offers>>[number] | undefined;
      for (let i = 0; i < 100 && offer === undefined; i++) offer = (await client.offers({ waitMs: 100 })).find((o) => o.order.attemptId === attemptId && !seenPlacements.has(o.placement));
      assert.ok(offer, "the host was offered the attempt");
      seenPlacements.add(offer.placement);
      assert.equal(await runner!.run(offer), "completed");
      await c.dispatch!.dispatcher.idle();
      return offer.order;
    };
    const CORRECTION = "Owner correction: plan A is withdrawn, use plan B.";
    const count = (text: string, part: string): number => text.split(part).length - 1;

    // The first run: nothing has been selected for the task, so the offer carries no updates and nothing is placed.
    const first = await runOnce();
    assert.equal("contextUpdates" in first, false, "an order with no updates is offered without the field");
    assert.equal((await get()).state, "waiting");
    assert.equal(answer.seen.length, 1);
    assert.ok(answer.seen.every((m) => !m.includes("side line of work")));

    // An inquiry on the task: a side line selects the owner's decision A, the owner's correction is recorded (B supersedes A), the correction is selected, and the side line returns to the task.
    const decisionA = await s.desks.write(ann, { commandId: "dA", projectId: project, kind: "decision", title: "Plan", body: "Owner decision: use plan A.", visibility: "shared", status: "accepted" } as never);
    const opened = await s.branches.open(ann, { commandId: "open", taskId, purpose: "Which plan are we on?" });
    let v = (await s.branches.view(ann, opened.id))!;
    await s.branches.applyUpdates(ann, { commandId: "uA", branchId: opened.id, expectedRevision: v.branch.revision, updates: [{ kind: "desk-record", id: decisionA.id }] });
    const decisionB = await s.desks.write(ann, { commandId: "dB", projectId: project, kind: "decision", title: "Plan", body: CORRECTION, visibility: "shared", status: "accepted", supersedes: decisionA.id } as never);
    v = (await s.branches.view(ann, opened.id))!;
    await s.branches.applyUpdates(ann, { commandId: "uB", branchId: opened.id, expectedRevision: v.branch.revision, updates: [{ kind: "desk-record", id: decisionB.id }] });
    v = (await s.branches.view(ann, opened.id))!;
    await s.branches.resume(ann, { commandId: "rsm", branchId: opened.id, expectedRevision: v.branch.revision });

    // The second run: the offer that came over the wire carries the correction only, and the remote machine's process places it before the turn, with the side line and record it came from.
    const second = await runOnce();
    assert.equal(second.contextUpdates?.length, 1, JSON.stringify(second.contextUpdates));
    assert.equal(second.contextUpdates![0]!.text, CORRECTION);
    assert.equal((await get()).turnRound, 2);
    assert.equal(answer.seen.length, 2);
    const call = answer.seen[1]!;
    assert.equal(count(call, CORRECTION), 1, call);
    assert.equal(count(call, `side line ${opened.id}, desk record ${decisionB.id}, update 2`), 1, "the update says where it came from");
    assert.ok(!call.includes("Owner decision: use plan A."), "the superseded decision is not given");
    const messages = JSON.parse(call) as { role: string; content: unknown }[];
    const at = (part: string): number => messages.findIndex((m) => JSON.stringify(m.content).includes(part));
    assert.ok(at("started on plan A") >= 0 && at("started on plan A") < at(CORRECTION) && at(CORRECTION) < at("This attempt goes on from where it stopped"), "the correction comes after the earlier turn and before this turn's instruction");

    // The third run is a new process on the same conversation, offered the same correction again: the request ID makes it apply once.
    const third = await runOnce();
    assert.deepEqual(third.contextUpdates, second.contextUpdates, "the same correction is offered again");
    assert.equal(answer.seen.length, 3);
    for (const seen of answer.seen.slice(1)) assert.equal(count(seen, CORRECTION), 1, "the correction is in the conversation exactly once");
  } finally {
    answer.server.closeAllConnections(); answer.server.close();
    await c.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
