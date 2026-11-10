import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { LocalWorker, type AttemptRuntime } from "../dispatch/local-worker.js";
import type { WorkerHost } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { EXEC_PROFILES, PI, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import { NotificationService } from "../notifications/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { startController } from "./index.js";
import type { DispatchStartOptions } from "./dispatch-compose.js";

/**
 * Card C07i through the composed controller: a task handed from attempt to attempt, each starting larger. The local host's guards give every first call to the watch; the third rise in a row raises ONE alert, which reaches
 * the owner's notifications once and stands as a warning in the task's status; the figures are read through the state API, the thresholds are set there, and nothing about the task or its attempts' content changes.
 */
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const ANN = "agt-annannannannannannan";
/** A 16384-token window: a startup limit of 4096 tokens. */
const table = {
  providers: { localp: { enabled: true, paid: false, location: "local" }, localq: { enabled: true, paid: false, location: "local" } },
  routes: { "localp/small": { contextTokens: 16_384, capabilities: ["tools"] }, "localq/small": { contextTokens: 16_384, capabilities: ["tools"] } },
  profiles: { "r-local": ["localp/small", "localq/small"] },
  roles: { coordinator: "r-local", "safety-supervisor": "r-local" },
};
type BuildServices = Parameters<NonNullable<DispatchStartOptions["local"]>["build"]>[0];

test("a task whose attempts start larger at each hand-off raises one alert for the owner and a warning on the task, read through the state API, with nothing cut (card C07i)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-c07i-"));
  const ran: string[] = [];
  const contents: string[] = [];
  // Each process says its first call is 300 tokens larger than the one before: 2000 characters of prompt and tools (667 tokens) and a growing start.
  let size = 100;
  const c = await startController({
    storage: { kind: "sqlite", path: join(dir, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true,
      local: {
        acceptUnenforcedLimits: true, window: () => undefined, close: async () => undefined,
        build: (s: BuildServices) => new LocalWorker({
          hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "c07i-test", capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }),
          guards: s.guards, sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
          runtimes: {
            open: async (order) => {
              const start = size; size += 300;
              const rt: AttemptRuntime = {
                firstCall: () => ({ systemPromptChars: 1000, toolSchemaChars: 1000, startupTokens: start, replyReserveTokens: 200 }),
                run: async (content) => { ran.push(order.attemptId); contents.push(content); return { status: "completed", text: "done", checkpoint: {} }; },
                checkpoint: async () => ({}), close: async () => undefined,
              };
              return rt;
            },
          },
        }) as unknown as WorkerHost,
      },
    },
  } as never);
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const ownerToken = (await s.principals.bootstrapOwner({ name: "rob" })).token;
    const owner = await s.principals.authenticate(ownerToken);
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(ownerToken, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: (await s.routing.get())?.revision ?? 0, table } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: ANN, grants: workGrants(project) });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
    await hosts.announce(hostP, { commandId: "an1", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });

    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Water the beds", description: "Every bed, morning and evening." })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: ANN } });
    const taskBefore = (await s.projects.getTask(taskId))!;
    for (let i = 0; i < 4; i++) {
      await hosts.heartbeat(hostP, { commandId: `hb${i}`, sequence: i + 1 });
      const a = (await s.assignments.getAssignment(taskId))!;
      await s.assignments.admitAttempt({ commandId: `ad${i}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ANN }, harness: "pi" });
      await c.dispatch.dispatcher.tick();
      await c.dispatch.dispatcher.idle();
    }
    assert.equal(ran.length, 4, "every attempt ran: the watch refuses nothing");

    // The figures, through the state API: four hand-offs on the local worker, each against the route's startup limit, with the task's own text named as a part.
    const read = await call("context.start-size.read", { taskId });
    assert.ok(read.ok, JSON.stringify(read.error));
    const item = read.result.item;
    assert.deepEqual(item.points.map((p: any) => [p.handoff, p.worker, p.tokens, p.limitTokens, p.admitted]), [[0, "local", 767, 4096, true], [1, "local", 1067, 4096, true], [2, "local", 1367, 4096, true], [3, "local", 1667, 4096, true]]);
    assert.ok(item.points[0].parts.task > 0, JSON.stringify(item.points[0].parts));
    assert.equal(item.alerts.trend.state, "open");
    assert.equal(item.raised, 1);

    // ONE alert reached the owner, as a notice naming the task and the trend.
    const inbox = await NotificationService.withEpoch(c.storage, c.epoch).inbox(owner);
    const told = [...inbox.items].filter((n) => n.ref.kind === "ctx-start-size");
    assert.equal(told.length, 1, JSON.stringify(inbox.items.map((n) => n.ref)));
    assert.match(told[0]!.detail ?? "", new RegExp(`^Task ${taskId}: its starting size rose over 3 hand-offs in a row \\(767 to 1667 tokens\\).*Nothing was cut`));
    // And the task shows it.
    const status = await call("status.ask", { request: { kind: "task", taskId } });
    assert.ok((status.result.item.lines as { text: string }[]).some((l) => /^Warning: its starting size rose over 3 hand-offs in a row/.test(l.text)), JSON.stringify(status.result.item.lines));

    // Watching changed no task content: the task is as it was, and every attempt was given the task's own text whole.
    const taskAfter = (await s.projects.getTask(taskId))!;
    assert.deepEqual([taskAfter.title, taskAfter.description], [taskBefore.title, taskBefore.description]);
    for (const content of contents) assert.ok(content.startsWith("Water the beds\n\nEvery bed, morning and evening."), content.slice(0, 200));

    // The thresholds through the state API: validated, and the owner's.
    assert.equal((await call("context.start-size.change", { set: { warnPercent: 60 } }, "w1")).ok, true);
    assert.equal((await call("context.start-size.change", { set: { warnPercent: 100 } }, "w2")).error?.code, "invalid_command");
    assert.deepEqual((await call("context.start-size.get", {})).result.item.effective, { risingHandoffs: 3, warnPercent: 60, minRisePercent: 1 });
    const annToken = (await s.principals.issueCredential(owner, `agent:${ANN}`)).token;
    assert.equal((await c.api.handle(annToken, { v: 1, op: "context.start-size.change", commandId: "x1", args: { set: { warnPercent: 70 } } } as never) as { error?: { code: string } }).error?.code, "forbidden");
  } finally { await c.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
