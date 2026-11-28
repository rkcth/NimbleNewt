import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService, DEFAULT_LIMITS } from "../admission/index.js";
import { BudgetService } from "../budgets/index.js";
import { CHAT_OPS, ScriptedInterpreter } from "../chat/index.js";
import type { WorkerTurnResult } from "../dispatch/ports.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { EXEC_PROFILES, PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { startController } from "./index.js";
import { OPERATION_BY_NAME } from "./operations.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const base = "a".repeat(40), tree = "b".repeat(40), patch = "c".repeat(40);

// Card P10b (first clause, the wake), through the composed controller: approved work in two projects, no integrator holding either branch. The controller's wake round gives each queue a free integrator as a landing
// task assigned to it (the oldest queue first, one project at a time); the owner's landing_queue view, in chat and through status.ask, says who was woken and with which task; a second round wakes nobody again; an
// integrator reading the queue sees no such line. No new operation, no new chat control and no interpreter text.
test("the controller wakes a free integrator for each queue with approved work, and the owner's landing_queue view says so (card P10b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p10b-wake-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const O = boot.token;
    const garden = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const orchard = (await s.projects.createProject({ commandId: "p2", actor: rob.id, name: "Orchard" })).id;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const hire = async (name: string, roles: string[], grants: { action: string; project: string }[]) => {
      const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
      const id = `agent:${made.id}`;
      for (const [i, g] of grants.entries()) await s.grants.grant(rob, { commandId: `g-${name}-${i}`, grantee: id, action: g.action, project: g.project, source: "direct", basis: "test" } as never);
      return { id, agentId: made.id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const both = [garden, orchard].map((project) => ({ action: "task.read", project }));
    const ann = await hire("Ann", ["author"], both);
    const rev = await hire("Rev", ["reviewer"], both);
    for (const [i, project] of [garden, orchard].entries()) assert.ok((await call(O, "project.branches.change", { project, landing: "main" }, `lb${i}`)).ok);
    let n = 0;
    const approved = async (projectId: string, title: string) => {
      n++;
      const task = (await s.projects.createTask({ commandId: `t-${n}`, actor: rob.id, projectId, title })).id;
      await s.projects.transitionTask({ commandId: `r-${n}`, actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
      await s.assignments.assignTask({ commandId: `as-${n}`, actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
      await s.assignments.admitAttempt({ commandId: `adm-${n}`, actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
      const made = await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base, tree, patchId: patch }, `code-${n}`);
      assert.equal(made.ok, true, JSON.stringify(made));
      assert.ok((await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: made.result.id, verdict: "approve" }, `rev-${n}`)).ok);
      return task;
    };
    const beans = await approved(garden, "Plant the beans");
    const apples = await approved(orchard, "Pick the apples");
    const view = async (token: string, projectId: string): Promise<string> => {
      const got = await call(token, "status.ask", { request: { kind: "landing_queue", projectId } });
      assert.equal(got.ok, true, JSON.stringify(got));
      return (got.result.item.lines as { text: string }[]).map((l) => l.text).join("\n");
    };

    // Nobody to wake yet: the round wakes nobody and says so in counts.
    const empty = await s.integratorWake.round();
    assert.deepEqual([empty.woken.length, empty.noneFree], [0, 2], JSON.stringify(empty));
    const ivy = await hire("Ivy", ["integrator"], [...both, { action: "integration.lease", project: garden }, { action: "integration.lease", project: orchard }]);
    const max = await hire("Max", ["integrator"], [{ action: "integration.lease", project: orchard }]);
    assert.match(await view(O, garden), /so the controller wakes one of them for this queue at its next round \(a landing task assigned to it\)/);

    // The round: Garden (approved first) to Ivy; Orchard to Max, since Ivy is busy with Garden's landing.
    const round = await s.integratorWake.round();
    assert.deepEqual(round.woken.map((w) => [w.projectId, w.agentId]), [[garden, ivy.agentId], [orchard, max.agentId]], JSON.stringify(round));
    const [gw, ow] = [round.woken[0]!, round.woken[1]!];
    const landing = (await s.projects.getTask(gw.taskId))!;
    assert.deepEqual([landing.projectId, landing.state, landing.title], [garden, "ready", "Land the approved work queued on main"]);
    assert.deepEqual((await s.assignments.getAssignment(gw.taskId))!.owner, { kind: "agent", id: ivy.agentId });
    // The dispatcher's view of the task: a landing task whose budget is the approved work's own task.
    assert.equal((await s.integratorWake.landingOf(gw.taskId))?.budgetTaskId, beans);
    assert.equal((await s.integratorWake.landingOf(ow.taskId))?.budgetTaskId, apples);
    assert.equal(await s.integratorWake.landingOf(beans), undefined);

    // The owner sees who was woken, with which task, in status.ask and in chat in the owner's own words (the existing view; nothing new for the interpreter).
    assert.match(await view(O, garden), new RegExp(`the controller woke integrator ${ivy.agentId} at [0-9T:.Z-]+ to land this queue with landing task ${gw.taskId}: its attempt starts in a place kept for landing, inquiries and reviews \\(author attempts never take one\\)`));
    await c.chat!.setFocus(O, { commandId: "f1", projectId: orchard });
    const q1 = "is anyone landing the apples?";
    say[q1] = [{ kind: "status", request: { kind: "landing_queue" }, evidence: q1, basis: "owner" }];
    const asked = (await c.chat!.submit(O, { messageId: "m1", text: q1 })).outcomes as any[];
    assert.equal(asked[0].status, "answered", JSON.stringify(asked));
    assert.match((asked[0].lines as { text: string }[]).map((l) => l.text).join("\n"), new RegExp(`the controller woke integrator ${max.agentId} at .* with landing task ${ow.taskId}`));
    // The integrator reading the queue: the queue, not who else was woken where.
    assert.doesNotMatch(await view(ivy.token, orchard), /woke|this branch's lease/);

    // A second round wakes nobody again and makes no other task.
    const again = await s.integratorWake.round();
    assert.deepEqual([again.woken.length, again.open], [0, 2]);
    // Ivy takes Garden's lease through the pool: held, the line says so.
    const took = await call(ivy.token, "integrator.pool.next", { ttlMs: 600_000 }, "i1");
    assert.deepEqual([took.result.outcome, took.result.projectId], ["taken", garden], JSON.stringify(took));
    assert.match(await view(O, garden), new RegExp(`Integrator ${ivy.agentId} holds the integrator lease of this branch`));

    // Nothing new for chat or the API: no operation was added, and the interpreter knows no wake command.
    for (const op of ["integrator.wake", "integrator.pool.wake", "landing.wake"]) { assert.equal(OPERATION_BY_NAME.has(op), false, op); assert.equal(Object.hasOwn(CHAT_OPS, op), false, op); }
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});

const TABLE = {
  providers: { localp: { enabled: true, paid: false, location: "local" }, localq: { enabled: true, paid: false, location: "local" } },
  routes: { "localp/small": { contextTokens: 128_000, capabilities: ["tools"] }, "localp/other": { contextTokens: 128_000, capabilities: ["tools"] }, "localq/judge": { contextTokens: 128_000, capabilities: ["tools"] }, "localq/backup": { contextTokens: 128_000, capabilities: ["tools"] } },
  profiles: { "r-local": ["localp/small", "localq/backup"], judge: ["localq/judge", "localp/other"] }, roles: { coordinator: "r-local", "safety-supervisor": "judge" },
};

// The same through the running dispatcher: its own round (a sweep of the tick) wakes the integrator, and the landing task's attempt is admitted in a `landing` place while the author attempts fill the one productive
// place and its queue, with its budget held on the approved work's own task. This proves the wiring in the composed controller (the sweep, the dispatcher's `landingOf`, the admission class and the budget).
test("through the running dispatcher: the wake is a round of the tick, and the landing attempt starts in a reserved place with its budget on the queued work's task while author work saturates (card P10b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p10b-wake2-"));
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const landingTasks = new Set<string>();
  let seen: { classes: string[]; project?: string; agent?: string; holders: string[]; productiveWaiting: number } | undefined;
  let admission: AdmissionService | undefined, budgets: BudgetService | undefined, ownerP: any, beans = "";
  const worker = new ScriptedWorker("host:w1", async ({ order }): Promise<WorkerTurnResult> => {
    if (landingTasks.has(order.taskId)) {
      const snap = await admission!.snapshot();
      const mine = snap.running.find((e) => e.class === "landing");
      seen = { classes: snap.running.map((e) => e.class), ...(mine?.project === undefined ? {} : { project: mine.project }), ...(mine?.agent === undefined ? {} : { agent: mine.agent }), holders: (await budgets!.report(ownerP, beans))!.reservations.map((x) => x.agentId ?? "").sort(), productiveWaiting: snap.queue.filter((e) => e.class === "productive").length };
      return { status: "completed", text: "landed" };
    }
    await gate;
    return { status: "completed", text: "written" };
  });
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), manual: true, workers: [worker] }, chat: { interpreter: new ScriptedInterpreter(() => []) } } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    ownerP = rob;
    const O = boot.token;
    admission = AdmissionService.withEpoch(c.storage, c.epoch);
    budgets = BudgetService.withEpoch(c.storage, c.epoch);
    await s.routing.setTable(rob, { commandId: "rt", expectedRevision: 0, table: TABLE } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(rob, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(rob, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(rob, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
    await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
    let beat = 0;
    const heartbeat = async (): Promise<void> => { await hosts.heartbeat(hostP, { commandId: `hb${++beat}`, sequence: beat }); };
    await heartbeat();
    await admission.setCapacity({ commandId: "cap", actor: rob.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    // Saturated author work: one productive place and one waiting place.
    await admission.setLimits({ commandId: "lim", actor: rob.id, limits: { ...DEFAULT_LIMITS, productive: 1, perHost: 1, queue: 1 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(rob, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const garden = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const hire = async (name: string, grants: { action: string; project: string }[], roles: string[]) => {
      const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
      const id = `agent:${made.id}`;
      for (const [i, g] of grants.entries()) await s.grants.grant(rob, { commandId: `g-${name}-${i}`, grantee: id, action: g.action, project: g.project, source: "direct", basis: "test" } as never);
      return { id, agentId: made.id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const ann = await hire("Ann", workGrants(garden), ["author"]);
    const rev = await hire("Rev", [{ action: "task.read", project: garden }], ["reviewer"]);
    const ivy = await hire("Ivy", [...workGrants(garden), { action: "integration.lease", project: garden }], ["integrator"]);
    assert.ok((await call(O, "project.branches.change", { project: garden, landing: "main" }, "lb")).ok);
    const authored = async (n: number, approve: boolean): Promise<string> => {
      const task = (await s.projects.createTask({ commandId: `t-${n}`, actor: rob.id, projectId: garden, title: `Write part ${n}` })).id;
      await s.projects.transitionTask({ commandId: `r-${n}`, actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
      await s.assignments.assignTask({ commandId: `as-${n}`, actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.agentId } } as never);
      await s.assignments.admitAttempt({ commandId: `adm-${n}`, actor: "inbox", taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.agentId }, harness: "pi" } as never);
      if (approve) {
        const made = await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base, tree, patchId: patch }, `code-${n}`);
        assert.equal(made.ok, true, JSON.stringify(made));
        assert.ok((await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: made.result.id, verdict: "approve" }, `rev-${n}`)).ok);
      }
      return task;
    };
    beans = await authored(1, true);
    await authored(2, false); await authored(3, false);
    // Room for the author's own running attempt and the landing (each holds up to an hour of compute); with less, the landing waits with a budget blocker on its task, as any attempt does.
    await budgets.open(rob, { commandId: "bo", taskId: beans, currency: "USD", costMicros: 10_000, computeMs: 10 * 3_600_000 });

    // One tick: the author attempts take the productive place and its queue, and the wake round (a sweep of the tick) gives the queue to Ivy.
    await c.dispatch!.dispatcher.tick();
    const snap = await admission.snapshot();
    assert.deepEqual([snap.running.filter((e) => e.class === "productive").length, snap.queue.length], [1, 1], JSON.stringify(snap));
    const wakes = await s.integratorWake.now();
    assert.deepEqual(wakes.open.map((w) => w.agentId), [ivy.agentId], JSON.stringify(wakes));
    const landingTask = wakes.open[0]!.taskId;
    landingTasks.add(landingTask);
    // Its attempt admitted as the inbox does; the next tick starts it.
    const asg = (await s.assignments.getAssignment(landingTask))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "adm-l", actor: "inbox", taskId: landingTask, expectedRevision: asg.revision, generation: asg.generation, owner: { kind: "agent", id: ivy.agentId }, harness: "pi" } as never)).id;
    await heartbeat();
    const tick = await c.dispatch!.dispatcher.tick();
    assert.ok(tick.started.includes(attemptId), JSON.stringify([tick.started, tick.blocked, await Promise.all(tick.blocked.map(async (b) => (await c.storage.getAggregate({ kind: "blocker", id: b.blockerId }))?.body))]));
    for (let i = 0; i < 500 && seen === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    // The landing's hold is on the approved work's own task, next to its author's: one each.
    assert.deepEqual(seen, { classes: ["productive", "landing"], project: garden, agent: ivy.id, holders: [ann.id, ivy.id].sort(), productiveWaiting: 1 }, JSON.stringify(seen));
    assert.equal(await budgets.report(rob, landingTask), undefined, "the landing task has no budget of its own");
    assert.equal((await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))?.ask?.landing, true);
  } finally { open(); await c.dispatch?.dispatcher.idle().catch(() => undefined); await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
