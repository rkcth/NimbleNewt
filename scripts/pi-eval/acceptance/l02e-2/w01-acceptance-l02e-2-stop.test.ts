// W01 acceptance for card L02e (l02e-2): the stop service side. Self-contained (its own scripted runtime, like
// lifecycle/stop-suite.ts at the base), so it does not depend on the shared suite's helpers.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, GrantService, type Grant, type Principal } from "../security/index.js";
import { PauseService, StopService, type InventoryItem, type StopPorts } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-28T10:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-w01-${n++}`;
let mayHoldHook: (requestedBy: string, taskId: string) => Promise<boolean> = async () => true;

/** A runtime each test scripts. */
class Runtime implements StopPorts {
  items: InventoryItem[] = [];
  cleanups: Array<Awaited<ReturnType<StopPorts["cleanup"]>>> = [{ remaining: [] }];
  seenAttempts: string[] = [];
  terminateCosts: Array<{ attemptId: string; costMicros?: number; computeMs?: number }> | undefined;
  charges: Array<{ commandId: string; attemptId: string; costMicros: number; computeMs: number }> = [];
  failCharges = 0;
  unsupported(): string | undefined { return undefined; }
  attempts(): string[] { return this.seenAttempts; }
  remember(): void { /* nothing */ }
  async begin(): Promise<void> { /* nothing */ }
  async release(): Promise<void> { /* nothing */ }
  async inventory(): Promise<InventoryItem[]> { return this.items; }
  async cleanup() { return this.cleanups.length > 1 ? this.cleanups.shift()! : this.cleanups[0]!; }
  async checkpoint() { return { checkpointId: "cp-1", durable: true, artifactsDurable: true }; }
  async charge(c: { commandId: string; attemptId: string; costMicros: number; computeMs: number }): Promise<void> {
    if (this.failCharges > 0) { this.failCharges--; throw new Error("the budget could not be reached"); }
    if (!this.charges.some((x) => x.commandId === c.commandId)) this.charges.push(c);
  }
  async terminate() { return { ended: true, unresolved: [], ...(this.terminateCosts === undefined ? {} : { costs: this.terminateCosts }) }; }
}

interface Ctx {
  owner: Principal; mgr: Principal; task: string; agentA: string; project: string; rt: Runtime; stops: StopService; pauses: PauseService;
  assignments: AssignmentService; projects: ProjectService; agents: AgentService; runner: CommandRunner;
}

const swarmLink = async (runner: CommandRunner, child: string, parent: string, projectId: string): Promise<void> => {
  const ref = { kind: "swarm-link", id: child };
  await runner.command("test.link", { commandId: cid("link"), actor: "system" }, async () => ({
    payload: { child, parent },
    build: async () => ({ ref, creates: true, changes: [{ type: "create" as const, ref, body: { parentTaskId: parent, projectId, createdBy: "user:rob", createdAt: new Date(now).toISOString() } } as never], detail: {} }),
  }));
};
const fillIndex = async (c: { runner: CommandRunner }, prefix: string, count: number, body: (i: number) => { open: Record<string, unknown>; charge?: Record<string, unknown> }): Promise<void> => {
  for (let start = 0; start < count; start += 50) {
    const changes: Array<{ type: "create"; ref: { kind: string; id: string }; body: Record<string, unknown> }> = [];
    for (let i = start; i < Math.min(start + 50, count); i++) {
      const a = prefix + String(i).padStart(5, "0");
      const b = body(i);
      if (b.charge !== undefined) changes.push({ type: "create", ref: { kind: "stop-charge", id: a }, body: b.charge });
      changes.push({ type: "create", ref: { kind: "stop-charge-open", id: a }, body: b.open });
    }
    await c.runner.command("test.fill", { commandId: cid("fill"), actor: "system" }, async () => ({ payload: { start }, build: async () => ({ ref: changes[0]!.ref, creates: true, changes: changes as never, detail: {} }) }));
  }
};
const openCount = async (c: { runner: CommandRunner }): Promise<number> => {
  let total = 0;
  for (let afterId: string | undefined; ;) {
    const page = await c.runner.list("stop-charge-open", { ...(afterId === undefined ? {} : { afterId }), limit: 100 });
    total += page.length;
    if (page.length < 100) return total;
    afterId = page[page.length - 1]!.id;
  }
};
const MARK = "cleanup spend not charged";
const outcomeMarked = async (c: { runner: CommandRunner }, id: string): Promise<boolean> => (((await c.runner.get("stop-intent", id))!.body as { outcome?: { unresolved: string[] } }).outcome?.unresolved ?? []).includes(MARK);
const sumOf = (c: { rt: Runtime }, a: string): number => c.rt.charges.filter((x) => x.attemptId === a).reduce((s, x) => s + x.costMicros, 0);
const scopeOf = (task: string) => ({ kind: "task", id: task }) as const;
const agentScope = (c: { agentA: string }) => ({ kind: "agent", id: c.agentA }) as const;
const installation = { kind: "installation", id: "installation" } as const;

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-28T10:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        GrantService.withEpoch(world.storage, epoch, options);
        const agents = AgentService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const plain = async (nm: string, g: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const project = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
        const agentA = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "A" })).id;
        const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
        await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
        await assignments.assignTask({ commandId: cid("as"), actor: owner.id, taskId: task, owner: { kind: "agent", id: agentA } });
        const mgr = await plain("mgr", [{ action: "assignment.manage", project }, { action: "assignment.read", project }]);
        const pauses = PauseService.withEpoch(world.storage, epoch, {}, options);
        const rt = new Runtime();
        mayHoldHook = async () => true;
        const stops = StopService.withEpoch(world.storage, epoch, PauseService.withEpoch(world.storage, epoch, {}, options), rt, { ...options, mayHold: (by, t) => mayHoldHook(by, t) });
        await body({ owner, mgr, task, agentA, project, rt, stops, pauses, assignments, projects, agents, runner: new CommandRunner(world.storage, epoch, options) });
      } finally { await world.close(); }
    });

  suite("a task never stopped itself is answered by its agent's Stop, named through that scope; an asker who may not control the agent is told nothing; the task's own request wins once made", async (c) => {
    c.rt.seenAttempts = ["att-agent"];
    c.rt.items = [{ kind: "foreground", ref: "att-agent/c1", state: "running" }];
    c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-agent", costMicros: 40, computeMs: 3 }] }];
    const byAgent = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "stop", reason: "the agent is stopped" });
    await c.stops.advance(c.owner, { intentId: byAgent.intentId });
    const seen = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
    assert.equal(seen?.intentId, byAgent.intentId, "the task's view finds the stop made through its agent");
    assert.deepEqual(seen?.through, { kind: "agent", id: c.agentA }, "and names the scope it came through");
    assert.equal(seen?.spent, 40);
    assert.equal(typeof seen?.requestedAt, "string");
    assert.deepEqual(seen?.attempts, [{ attemptId: "att-agent", costMicros: 40, computeMs: 3, pending: false }]);
    // The agent's own view is its own request: no `through`.
    const ofAgent = await c.stops.cleanupSpend(c.owner, agentScope(c));
    assert.deepEqual([ofAgent?.intentId, ofAgent?.through], [byAgent.intentId, undefined]);
    assert.equal(await c.stops.cleanupSpend(c.mgr, scopeOf(c.task)), undefined, "whoever may control the task but not the agent is told nothing of the agent's stop");
    const own = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "the task itself" });
    await c.stops.advance(c.owner, { intentId: own.intentId });
    const later = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
    assert.deepEqual([later?.intentId, later?.through], [own.intentId, undefined], "the task's own request is the answer");
  });

  suite("the installation's, the team's above the agent and a swarm parent's Stop answer for the task, the newest of them", async (c) => {
    assert.equal(await c.stops.cleanupSpend(c.owner, scopeOf(c.task)), undefined, "nothing asked for any scope yet");
    c.rt.seenAttempts = ["att-inst"];
    c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-inst", costMicros: 80, computeMs: 2 }] }];
    const byInstallation = await c.stops.request(c.owner, { commandId: cid("s"), scope: installation, mode: "stop", reason: "shutting down" });
    await c.stops.advance(c.owner, { intentId: byInstallation.intentId });
    const inst = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
    assert.deepEqual([inst?.intentId, inst?.through, inst?.spent], [byInstallation.intentId, installation, 80]);
    const ofAgent = await c.stops.cleanupSpend(c.owner, agentScope(c));
    assert.deepEqual([ofAgent?.intentId, ofAgent?.through], [byInstallation.intentId, installation], "an agent is covered by the installation too");
    now += 60_000;
    const team = (await c.agents.createTeam(c.owner, { commandId: cid("team"), name: "Team One" })).id;
    const agent = await c.agents.get(c.owner, c.agentA);
    await c.agents.update(c.owner, { commandId: cid("mv"), agentId: c.agentA, expectedRevision: agent!.revision, teamId: team });
    c.rt.seenAttempts = ["att-team"];
    c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-team", costMicros: 30, computeMs: 2 }] }];
    const byTeam = await c.stops.request(c.owner, { commandId: cid("s"), scope: { kind: "team", id: team }, mode: "stop", reason: "the team is stopped" });
    await c.stops.advance(c.owner, { intentId: byTeam.intentId });
    const viaTeam = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
    assert.deepEqual([viaTeam?.intentId, viaTeam?.through, viaTeam?.spent], [byTeam.intentId, { kind: "team", id: team }, 30], "the newer team Stop answers, not the installation's");
    now += 60_000;
    const parent = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.project, title: "parent" })).id;
    await swarmLink(c.runner, c.task, parent, c.project);
    c.rt.seenAttempts = ["att-parent"];
    c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-parent", costMicros: 60, computeMs: 2 }] }];
    const byParent = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(parent), mode: "stop", reason: "the parent is stopped" });
    await c.stops.advance(c.owner, { intentId: byParent.intentId });
    const viaParent = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
    assert.deepEqual([viaParent?.intentId, viaParent?.through], [byParent.intentId, { kind: "task", id: parent }], "the swarm parent's newer Stop answers");
  });

  suite("a wider Stop made before the task existed, or before the task was given to that agent, is not the task's answer", async (c) => {
    c.rt.seenAttempts = ["att-old"];
    c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-old", costMicros: 10, computeMs: 1 }] }];
    const byInstallation = await c.stops.request(c.owner, { commandId: cid("s"), scope: installation, mode: "stop", reason: "shutting down" });
    await c.stops.advance(c.owner, { intentId: byInstallation.intentId });
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: installation, reason: "back" });
    assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.intentId, byInstallation.intentId, "the task that existed then was reached");
    now += 60_000;
    const later = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.project, title: "later" })).id;
    assert.equal(await c.stops.cleanupSpend(c.owner, scopeOf(later)), undefined, "a task created after that Stop was never reached by it");
    now += 60_000;
    const byAgent = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "stop", reason: "agent" });
    await c.stops.advance(c.owner, { intentId: byAgent.intentId });
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: agentScope(c), reason: "back" });
    assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.intentId, byAgent.intentId, "the agent's task then is answered by the agent's Stop");
    now += 60_000;
    await c.projects.transitionTask({ commandId: cid("r"), actor: c.owner.id, taskId: later, expectedRevision: 1, to: "ready" });
    await c.assignments.assignTask({ commandId: cid("as"), actor: c.owner.id, taskId: later, owner: { kind: "agent", id: c.agentA } });
    assert.equal(await c.stops.cleanupSpend(c.owner, scopeOf(later)), undefined, "a task given to the agent after its Stop was not reached by it");
  });

  suite("an agent's Stop holds the swarm children of its tasks for a wider look only; not a child the requester may not control; a resume lets go", async (c) => {
    const byAgent = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "stop", reason: "agent" });
    await c.stops.advance(c.owner, { intentId: byAgent.intentId });
    assert.equal(await c.stops.holding(c.task, "child-y"), undefined, "the task has no Stop of its own");
    assert.equal((await c.stops.holding(c.task, "child-y", { wider: true }))?.intentId, byAgent.intentId, "the agent's Stop holds the children");
    mayHoldHook = async (_by, child) => child !== "child-x";
    assert.equal(await c.stops.holding(c.task, "child-x", { wider: true }), undefined, "not a child the requester may not control");
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: agentScope(c), reason: "back" });
    assert.equal(await c.stops.holding(c.task, "child-y", { wider: true }), undefined, "the resume lets go");
  });

  suite("a Force Stop, resumed and then merely paused again, no longer holds: an agent's through a wider look, and the task's own", async (c) => {
    const agent = agentScope(c);
    const forced = await c.stops.force(c.owner, { commandId: cid("f"), scope: agent, reason: "on fire" });
    assert.equal((await c.stops.holding(c.task, "child-y", { wider: true }))?.intentId, forced.intentId, "held while the Force Stop's pause stands");
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: agent, reason: "back" });
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: agent, reason: "just a pause" });
    assert.equal(await c.stops.holding(c.task, "child-y", { wider: true }), undefined, "the finished Force Stop is not the cause of this pause");
    const own = await c.stops.force(c.owner, { commandId: cid("f2"), scope: scopeOf(c.task), reason: "on fire" });
    assert.equal((await c.stops.holding(c.task))?.intentId, own.intentId);
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "back" });
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: scopeOf(c.task), reason: "just a pause" });
    assert.equal(await c.stops.holding(c.task), undefined, "nor the task's own finished Force Stop");
  });

  suite("2000 settled entries listing only a blocked Stop do not keep a later unpaid charge from being paid by the sweep", async (c) => {
    c.rt.seenAttempts = [];
    c.rt.items = [{ kind: "process", ref: "pid-7", state: "uncooperative" }];
    c.rt.cleanups = [{ remaining: [{ kind: "process", ref: "pid-7", state: "uncooperative" }] }];
    const blocked = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "will not settle" });
    assert.equal((await c.stops.advance(c.owner, { intentId: blocked.intentId })).phase, "blocked");
    // Entries whose charge is made and that want nothing more, each listing only the blocked request, sorting before every other attempt.
    await fillIndex(c, "b", 2000, () => ({ open: { intents: [blocked.intentId], settled: false }, charge: { costMicros: 5, computeMs: 0 } }));
    c.rt.items = [];
    c.rt.cleanups = [{ remaining: [] }];
    c.rt.terminateCosts = [{ attemptId: "zzlate", costMicros: 30, computeMs: 0 }];
    c.rt.failCharges = 1;
    const later = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "stop", reason: "later" });
    await c.stops.advance(c.owner, { intentId: later.intentId });
    assert.equal(sumOf(c, "zzlate"), 0, "its charge failed and is still to be made");
    c.rt.failCharges = 0;
    for (let i = 0; i < 3 && sumOf(c, "zzlate") === 0; i++) await c.stops.sweep(c.owner);
    assert.equal(sumOf(c, "zzlate"), 30, "a few sweeps reach the later charge: the window is not starved");
    assert.equal(((await c.runner.get("stop-intent", blocked.intentId))!.body as { phase: string }).phase, "blocked", "the unfinished request is left blocked");
    await c.stops.sweep(c.owner);
    assert.equal(await outcomeMarked(c, later.intentId), false, "and the later request's mark is cleared");
    assert.ok(await openCount(c) < 2000, "settled entries are not all kept by the unfinished request");
  });
}
