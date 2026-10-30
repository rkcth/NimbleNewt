import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
import { DeskService } from "../context/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService, type BlockerBasis, type BlockerType } from "../domain/blockers.js";
import { EffectService } from "../domain/effects.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { InboxService } from "../domain/inbox.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { WaitService } from "../domain/waits.js";
import { EventService, WatchService } from "../events/index.js";
import { StallService } from "../health/index.js";
import { HostService } from "../hosts/index.js";
import { PauseService } from "../lifecycle/index.js";
import { McpService, type CatalogItem } from "../mcp/index.js";
import { ContractService } from "../planning/contracts.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { StatusService, type StatusDeps, type StatusOptions, type StatusRequest } from "./index.js";
import type { Line } from "./index.js";

after(stopServer);

const T0 = Date.parse("2026-10-22T08:00:00.000Z");
const MIN = 60_000;
let now = T0;
const at = (): string => new Date(now).toISOString();
const options = { clock: at, pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};
type AGrant = { action: string; project: string; resource?: { kind: string; id: string }; expiresAt?: string };
const SDK = { name: "@modelcontextprotocol/sdk", version: "1.12.0" };
const item = (name: string): CatalogItem => ({ name, descriptionDigest: "a".repeat(64), schemaDigest: "b".repeat(64) });
/** Every sentence of an answer rests on at least one record. */
const cited = (lines: readonly Line[]): void => { assert.ok(lines.length > 0, "an answer has lines"); for (const l of lines) { assert.ok(l.text.length > 0); assert.ok(l.cites.length > 0, `uncited: ${l.text}`); for (const c of l.cites) assert.ok(c.kind.length > 0 && c.id.length > 0); } };
const said = (lines: readonly Line[]): string => lines.map((l) => l.text).join("\n");

for (const backend of backends) {
  interface Ctx {
    status: StatusService; owner: Principal; project: string; other: string; storage: ControllerStorage; epoch: number;
    projects: ProjectService; assignments: AssignmentService; waits: WaitService; blockers: BlockerService; contracts: ContractService; stall: StallService; pauses: PauseService;
    desks: DeskService; mcp: McpService; artifacts: ArtifactService; blobs: FileBlobStore; watches: WatchService; events: EventService; hosts: HostService; principals: PrincipalService; agents: AgentService;
    rebuild(extra?: StatusOptions, deps?: { watch?: boolean; verify?: boolean; ownerQuestions?: NonNullable<StatusDeps["ownerQuestions"]> }): StatusService;
    agent(name: string, grants?: AGrant[]): Promise<Principal>;
    host(name: string, project?: string): Promise<Principal>;
    /** A ready task in `project` (default: the main one), created by the owner. */
    ready(title?: string, project?: string): Promise<string>;
    /** A task in progress under `who` with an active attempt, created by the owner. */
    work(title?: string, who?: string, project?: string): Promise<string>;
    /** Owner's activity report for the task (the owner of record seen working). */
    seen(taskId: string, by?: string, kind?: string): Promise<void>;
    block(taskId: string, type: BlockerType, basis: BlockerBasis | undefined, extra?: { summary?: string; resolver?: string; subject?: { kind: string; id: string } }): Promise<string>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = T0;
      const world = await backend.open();
      const dir = mkdtempSync(join(tmpdir(), "nn status-"));
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const waits = WaitService.withEpoch(world.storage, epoch, assignments, options);
        const blockers = BlockerService.withEpoch(world.storage, epoch, options);
        const contracts = ContractService.withEpoch(world.storage, epoch, options);
        const agents = AgentService.withEpoch(world.storage, epoch, options);
        const hosts = HostService.withEpoch(world.storage, epoch, assignments, { ...options, staleAfterMs: 60_000 });
        const stall = StallService.withEpoch(world.storage, epoch, assignments, waits, { ...options, hostStaleAfterMs: 60_000 });
        const pauses = PauseService.withEpoch(world.storage, epoch, { waits }, options);
        const desks = DeskService.withEpoch(world.storage, epoch, options);
        const events = EventService.withEpoch(world.storage, epoch, options);
        const inbox = InboxService.withEpoch(world.storage, epoch, assignments, options);
        const watches = WatchService.withEpoch(world.storage, epoch, { events, inbox, assignments, projects }, options);
        const mcp = McpService.withEpoch(world.storage, epoch, options);
        const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
        const artifacts = ArtifactService.withEpoch(world.storage, epoch, blobs, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
        const other = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Q" })).id;
        const rebuild: Ctx["rebuild"] = (extra = {}, deps = {}) => StatusService.withEpoch(world.storage, epoch, {
          assignments, waits, blockers, contracts, stall, pauses,
          ...(deps.watch === false ? {} : { watch: watches }), ...(deps.ownerQuestions === undefined ? {} : { ownerQuestions: deps.ownerQuestions }), ...(deps.verify === false ? {} : { verifyArtifact: (id: string) => artifacts.verify(id) }),
        }, { ...options, ...extra });
        const status = rebuild();
        const grantService = GrantService.withEpoch(world.storage, epoch, options);
        const make = async (kind: "agent" | "host", nm: string, grants: AGrant[]): Promise<Principal> => {
          const plain = grants.filter((g) => g.resource === undefined && g.expiresAt === undefined);
          await principals.enroll(owner, { commandId: cid("e"), kind, name: nm, grants: plain });
          for (const g of grants.filter((x) => x.resource !== undefined || x.expiresAt !== undefined)) await grantService.grant(owner, { commandId: cid("g"), grantee: `${kind}:${nm}`, action: g.action, project: g.project, source: "direct", basis: "the owner said so", ...(g.resource === undefined ? {} : { resource: g.resource }), ...(g.expiresAt === undefined ? {} : { expiresAt: g.expiresAt }) } as never);
          return principals.authenticate((await principals.issueCredential(owner, `${kind}:${nm}`)).token);
        };
        const agent: Ctx["agent"] = (nm, grants = []) => make("agent", nm, grants);
        const host: Ctx["host"] = (nm, proj = project) => make("host", nm, [{ action: "attempt.work", project: proj }]);
        const ready: Ctx["ready"] = async (title = "work", proj = project) => {
          const id = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: proj, title })).id;
          await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: id, expectedRevision: 1, to: "ready" });
          return id;
        };
        const work: Ctx["work"] = async (title = "work", who = "ann", proj = project) => {
          const id = await ready(title, proj);
          const ownerRef = { kind: "agent", id: who };
          await assignments.assignTask({ commandId: cid("as"), actor: owner.id, taskId: id, owner: ownerRef });
          const a = (await assignments.getAssignment(id))!;
          await assignments.admitAttempt({ commandId: cid("ad"), actor: owner.id, taskId: id, expectedRevision: a.revision, generation: a.generation, owner: ownerRef });
          const t = (await projects.getTask(id))!;
          await projects.transitionTask({ commandId: cid("ip"), actor: owner.id, taskId: id, expectedRevision: t.revision, to: "in_progress" });
          return id;
        };
        const seen: Ctx["seen"] = async (taskId, by, kind = "editing") => {
          const a = (await assignments.getAssignment(taskId))!;
          await assignments.observeActivity({ commandId: cid("ob"), actor: owner.id, taskId, observedBy: by ?? `agent:${a.owner!.id}`, generation: a.generation, kind, detail: "src/app.ts" });
        };
        const block: Ctx["block"] = async (taskId, type, basis, extra = {}) =>
          (await blockers.openBlocker({ commandId: cid("b"), actor: owner.id, type, subject: extra.subject ?? { kind: "task", id: taskId }, summary: extra.summary ?? `${type} on the task`, resolver: extra.resolver ?? "owner", ...(basis === undefined ? {} : { basis }) })).id;
        await body({ status, owner, project, other, storage: world.storage, epoch, projects, assignments, waits, blockers, contracts, stall, pauses, desks, mcp, artifacts, blobs, watches, events, hosts, principals, agents, rebuild, agent, host, ready, work, seen, block });
      } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); await world.close(); }
    });

  suite("the owner of record and the observed worker are told apart: only a recent sign by the owner under the current generation is working", async (c) => {
    const t = await c.work("Build the parser");
    let s = (await c.status.task(c.owner, t))!;
    assert.equal(s.owner!.id, "ann");
    assert.equal(s.execution!.state, "unknown", "an active attempt with no sign of work is not working");
    assert.match(said(s.lines), /recorded as running, but that is not confirmed/);
    assert.match(said(s.lines), /no sign of work has been seen/);
    cited(s.lines);
    // The owner is seen working.
    now += MIN;
    await c.seen(t);
    s = (await c.status.task(c.owner, t))!;
    assert.equal(s.execution!.state, "working");
    assert.equal(s.execution!.observation!.byOwner, true);
    assert.equal(s.execution!.observation!.freshness, "fresh");
    assert.match(said(s.lines), /Work was last seen under a minute ago/);
    // Time alone turns it into unknown: medium work is stale after 20 minutes of silence.
    now += 21 * MIN;
    s = (await c.status.task(c.owner, t))!;
    assert.equal(s.execution!.state, "unknown");
    assert.equal(s.execution!.observation!.freshness, "stale");
    assert.match(said(s.lines), /21 min old/);
    assert.equal(s.observedAt, at(), "observation time is the controller's own clock");
    // Someone else seen on the task is not the owner working.
    const stranger = await c.host("hx");
    const a = (await c.assignments.getAssignment(t))!;
    await c.hosts.reportProgress(stranger, { commandId: cid("pr"), taskId: t, generation: a.generation, kind: "compiling" });
    s = (await c.status.task(c.owner, t))!;
    assert.equal(s.execution!.state, "unknown");
    assert.equal(s.execution!.observation!.byOwner, false);
    assert.match(said(s.lines), /who is not the owner of record/);
    // After a transfer the old owner's sign belongs to an earlier generation.
    await c.seen(t);
    assert.equal((await c.status.task(c.owner, t))!.execution!.state, "working");
    await c.assignments.transferTask({ commandId: cid("tr"), actor: c.owner.id, taskId: t, expectedRevision: a.revision, to: { kind: "agent", id: "ben" } });
    s = (await c.status.task(c.owner, t))!;
    assert.equal(s.owner!.id, "ben");
    assert.equal(s.execution!.state, "assigned_not_started", "the new owner has not started; the old owner's activity does not carry over");
    assert.equal(s.execution!.observation!.currentGeneration, false);
    assert.match(said(s.lines), /earlier owner/);
    // The same owner given the task again is a new generation: the sign of work from the first one does not count for it.
    const t3 = await c.work("same owner again", "dana");
    await c.seen(t3);
    assert.equal((await c.status.task(c.owner, t3))!.execution!.state, "working");
    const a3 = (await c.assignments.getAssignment(t3))!;
    const released = await c.assignments.releaseTask({ commandId: cid("rl"), actor: c.owner.id, taskId: t3, expectedRevision: a3.revision });
    await c.assignments.assignTask({ commandId: cid("as"), actor: c.owner.id, taskId: t3, expectedRevision: released.revision, owner: { kind: "agent", id: "dana" } });
    const a4 = (await c.assignments.getAssignment(t3))!;
    assert.equal(a4.generation, a3.generation + 1);
    await c.assignments.admitAttempt({ commandId: cid("ad"), actor: c.owner.id, taskId: t3, expectedRevision: a4.revision, generation: a4.generation, owner: { kind: "agent", id: "dana" } });
    s = (await c.status.task(c.owner, t3))!;
    assert.equal(s.execution!.state, "unknown", "the old generation's sign of work is not this generation's");
    assert.equal(s.execution!.observation!.currentGeneration, false);
    assert.match(said(s.lines), /earlier owner/);
    await c.seen(t3);
    assert.equal((await c.status.task(c.owner, t3))!.execution!.state, "working");
    // Owned but not started, and a task nobody owns.
    const idle = await c.ready("idle");
    assert.equal((await c.status.task(c.owner, idle))!.execution!.state, "not_assigned", "no assignment: nobody is claimed to be working");
    assert.match(said((await c.status.task(c.owner, idle))!.lines), /Nobody owns it/);
    // A host reporting through stall evidence for the owner's task counts as the owner's worker while the host is fresh, and stops counting when it goes quiet.
    const t2 = await c.work("evidence task", "carl");
    const h = await c.host("h1");
    const a2 = (await c.assignments.getAssignment(t2))!;
    await c.hosts.announce(h, { commandId: cid("an"), capabilities: { os: "linux", arch: "x64", harnesses: [], isolation: [], tools: [], workspaces: [] } });
    await c.hosts.heartbeat(h, { commandId: cid("hb"), sequence: 1 });
    await c.stall.report(h, { commandId: cid("rp"), taskId: t2, generation: a2.generation, event: { type: "step", label: "compile" } });
    s = (await c.status.task(c.owner, t2))!;
    assert.equal(s.execution!.state, "working");
    now += 2 * MIN; // beyond the host freshness window of one minute, within the work window
    s = (await c.status.task(c.owner, t2))!;
    assert.equal(s.execution!.state, "unknown");
    assert.match(said(s.lines), /has not been heard from lately/);
  });

  suite("a pause is shown as intent with the observed state beside it, not as work", async (c) => {
    const t = await c.work("Paused work");
    await c.seen(t);
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "task", id: t }, reason: "owner wants to look first" });
    const s = (await c.status.task(c.owner, t))!;
    assert.equal(s.execution!.state, "paused");
    assert.equal(s.pause!.paused, true);
    assert.equal(s.pause!.gates[0]!.observed, "pausing");
    assert.match(said(s.lines), /It is paused \(task .*observed pausing\)/);
    // Time promotes nothing.
    now += 3 * 60 * MIN;
    assert.equal((await c.status.task(c.owner, t))!.pause!.gates[0]!.observed, "pausing");
    cited(s.lines);
  });

  suite("the exact pending dependency, wait and retry are shown", async (c) => {
    await c.agent("dora");
    const pre = await c.ready("Write the schema");
    const t = await c.work("Use the schema");
    const dep = await c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t, prerequisiteId: pre, responsible: "agent:dora" });
    void dep;
    let s = (await c.status.task(c.owner, t))!;
    assert.deepEqual(s.pending.map((p) => p.kind), ["dependency"]);
    assert.match(said(s.lines), new RegExp(`waiting for Write the schema \\(${pre}\\), which is ready to be worked on; agent:dora is answerable`));
    // The prerequisite is cancelled: it will never finish.
    const p = (await c.projects.getTask(pre))!;
    await c.projects.transitionTask({ commandId: cid("x"), actor: c.owner.id, taskId: pre, expectedRevision: p.revision, to: "cancelled" });
    s = (await c.status.task(c.owner, t))!;
    assert.equal((s.pending[0] as { willNotFinish: boolean }).willNotFinish, true);
    assert.match(said(s.lines), /cancelled and will never finish/);
    // A done prerequisite is not pending.
    const pre2 = await c.ready("second");
    const t2 = await c.work("needs second");
    await c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t2, prerequisiteId: pre2 });
    assert.equal((await c.status.task(c.owner, t2))!.pending.length, 1);
    const q = (await c.projects.getTask(pre2))!;
    await c.projects.transitionTask({ commandId: cid("ip"), actor: c.owner.id, taskId: pre2, expectedRevision: q.revision, to: "in_progress" });
    await c.projects.transitionTask({ commandId: cid("dn"), actor: c.owner.id, taskId: pre2, expectedRevision: q.revision + 1, to: "done" });
    assert.equal((await c.status.task(c.owner, t2))!.pending.length, 0);
    // A typed wait: reason, resolver, next action and the deadline with what happens at it.
    const t3 = await c.work("needs an answer");
    await c.waits.openWait({ commandId: cid("w"), actor: c.owner.id, taskId: t3, reason: "approval", resolver: "owner", summary: "May I use the paid API?", nextAction: "call the API", deadline: new Date(now + 60 * MIN).toISOString(), onDeadline: "cancel" });
    s = (await c.status.task(c.owner, t3))!;
    assert.equal(s.task.state, "blocked");
    assert.match(said(s.lines), /Waiting for you \(approval\): May I use the paid API\? When answered: call the API\. Deadline .*; then it will be cancelled\./);
    assert.equal(s.blockers.length, 0);
    assert.doesNotMatch(said(s.lines), /no record says why/);
    const t4 = await c.work("held");
    await c.waits.openWait({ commandId: cid("w"), actor: c.owner.id, taskId: t4, reason: "external", resolver: "agent:vendor", summary: "vendor reply", nextAction: "integrate", indefinite: { owner: "rob" } });
    assert.match(said((await c.status.task(c.owner, t4))!.lines), /No deadline; rob holds it\./);
    // A blocked task nothing explains is said to be unexplained.
    const t5 = await c.work("mystery");
    const m = (await c.projects.getTask(t5))!;
    await c.projects.transitionTask({ commandId: cid("bl"), actor: c.owner.id, taskId: t5, expectedRevision: m.revision, to: "blocked" });
    assert.match(said((await c.status.task(c.owner, t5))!.lines), /blocked, but no record says why/);
    // A task event that could not be announced: the retry is shown with the next attempt and the last error.
    const fresh = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.project, title: "never announced" })).id;
    const claims = await c.storage.claimDeliveries({ epoch: c.epoch, destination: "task-events", claimant: "tester", now: at(), leaseMs: 60_000, limit: 100 });
    const mine = claims.find((x) => x.aggregate.id === fresh)!;
    assert.ok(mine, "the event of the task's first revision is claimable");
    await c.storage.retryDelivery({ epoch: c.epoch, deliveryId: mine.deliveryId, claimToken: mine.claimToken, nextAttemptAt: new Date(now + 5 * MIN).toISOString(), reason: "the bridge was down; token=sk-abcdefghijklmnopqrstuvwxyz012345", at: at() });
    s = (await c.status.task(c.owner, fresh))!;
    const retry = s.pending.find((x) => x.kind === "retry") as { attempts: number; nextAttemptAt: string; lastError: string };
    assert.equal(retry.attempts, 1);
    assert.equal(retry.nextAttemptAt, new Date(now + 5 * MIN).toISOString());
    assert.doesNotMatch(retry.lastError, /sk-abcdef/);
    assert.match(said(s.lines), /has not gone out yet: 1 attempt so far, next try .*, last error: the bridge was down/);
    cited(s.lines);
  });

  suite("a task is done only when its record says so, and then with its open doubts beside it", async (c) => {
    const t = await c.work("Ship it");
    await c.seen(t);
    // Producing an artifact, finishing the attempt and reporting evidence do not complete the task.
    await c.artifacts.publish({ commandId: cid("art"), actor: c.owner.id, name: "build", projectId: c.project, taskId: t, files: [{ path: "out.txt", content: Buffer.from("built") }] });
    let s = (await c.status.task(c.owner, t))!;
    assert.equal(s.completion, "not_done");
    assert.doesNotMatch(said(s.lines), /\bdone\b/i);
    const a = (await c.assignments.getAssignment(t))!;
    await c.assignments.finishAttempt({ commandId: cid("fa"), actor: c.owner.id, taskId: t, expectedRevision: a.revision, fence: { generation: a.generation, attemptId: a.activeAttemptId! }, outcome: "succeeded", summary: "all built" });
    s = (await c.status.task(c.owner, t))!;
    assert.equal(s.completion, "not_done");
    assert.match(said(s.lines), /latest attempt ended as succeeded, but the task is not marked done/);
    // Marked done with an unsettled action: done, with its doubt.
    await c.block(t, "effect_uncertain", undefined, { summary: "the deploy call timed out", subject: { kind: "task", id: t } });
    const rec = (await c.projects.getTask(t))!;
    await c.projects.transitionTask({ commandId: cid("dn"), actor: c.owner.id, taskId: t, expectedRevision: rec.revision, to: "done" });
    s = (await c.status.task(c.owner, t))!;
    assert.equal(s.completion, "done_with_open_doubts");
    assert.match(said(s.lines), /marked done, but an action it took may or may not have happened/);
    // A clean done.
    const clean = await c.ready("clean");
    const r2 = (await c.projects.getTask(clean))!;
    await c.projects.transitionTask({ commandId: cid("ip"), actor: c.owner.id, taskId: clean, expectedRevision: r2.revision, to: "in_progress" });
    await c.projects.transitionTask({ commandId: cid("dn"), actor: c.owner.id, taskId: clean, expectedRevision: r2.revision + 1, to: "done" });
    assert.equal((await c.status.task(c.owner, clean))!.completion, "done");
    // Cancelled is not done.
    const gone = await c.ready("gone");
    await c.projects.transitionTask({ commandId: cid("cx"), actor: c.owner.id, taskId: gone, expectedRevision: 2, to: "cancelled" });
    assert.equal((await c.status.task(c.owner, gone))!.completion, "cancelled");
    // An unknown tool outcome is a doubt too.
    const server = await c.mcp.register(c.owner, { commandId: cid("rg"), name: "files", mode: "local", transport: "stdio", protocolRevision: "2025-06-18", sdk: SDK, launch: { command: "/opt/mcp/files-server", args: [], env: {}, secretRefs: [] }, audience: [c.project], allowed: { tools: ["read_file"], resources: [], prompts: [] } } as never);
    const hostP = await c.host("catalog");
    const snap = await c.mcp.recordCatalog(hostP, { commandId: cid("sn"), serverId: server.id, protocolRevision: "2025-06-18", tools: [item("read_file")] });
    await c.mcp.acceptCatalog(c.owner, { commandId: cid("ac"), serverId: server.id, revision: snap.revision, expectedRevision: 2 });
    const worker = await c.agent("mcpuser", [{ action: "attempt.work", project: c.project }, { action: "mcp.use", project: c.project }]);
    const t2 = await c.ready("uses a tool");
    await c.mcp.authorizeCall(worker, { commandId: cid("cl"), serverId: server.id, kind: "tool", name: "read_file", taskId: t2 });
    const r3 = (await c.projects.getTask(t2))!;
    await c.projects.transitionTask({ commandId: cid("ip"), actor: c.owner.id, taskId: t2, expectedRevision: r3.revision, to: "in_progress" });
    await c.projects.transitionTask({ commandId: cid("dn"), actor: c.owner.id, taskId: t2, expectedRevision: r3.revision + 1, to: "done" });
    s = (await c.status.task(c.owner, t2))!;
    assert.equal(s.completion, "done_with_open_doubts");
    assert.match(said(s.lines), /a tool call to files \(tool:read_file\) has no known outcome/);
    // A check that ran out of budget is a doubt, not a clean bill.
    const tiny = (await c.rebuild({ scanPageSize: 1, scanPages: 1 }).task(c.owner, t2))!;
    assert.equal(tiny.completion, "done_with_open_doubts");
    assert.match(said(tiny.lines), /the check for tool calls with an unknown outcome did not finish/);
  });

  suite("a blocker shows its kind and the way out; a supervisor's preference is advice on an owner-decided outcome and never a blocker", async (c) => {
    const t = await c.work("Blocked work");
    const kinds: [BlockerType, BlockerBasis | undefined, RegExp, RegExp][] = [
      ["delivery_exhausted", undefined, /a technical problem/, /find out why the message could not be delivered/],
      ["context_overflow", "enforced_permission", /an enforced permission boundary/, /you can grant it or choose another way/],
      ["scan_failure", "policy_conflict", /a conflict between configured policies/, /an explicit policy change is needed, made by you; no team decision replaces it/],
      ["manual_hold", undefined, /a hold placed by a person/, /only a person lifts it; nothing automatic clears it/],
    ];
    for (const [type, basis] of kinds) await c.block(t, type, basis, { summary: `the ${type} problem` });
    const s = (await c.status.task(c.owner, t))!;
    assert.deepEqual(s.blockers.map((b) => b.basis).sort(), ["enforced_permission", "owner_hold", "policy_conflict", "technical"]);
    for (const [type, , kind, route] of kinds) {
      const b = s.blockers.find((x) => x.type === type)!;
      assert.match(`${said(s.lines)}`, kind);
      assert.match(b.route, route);
      assert.equal(b.resolver, "owner");
    }
    cited(s.lines);
    // The same blocker seen by someone else names the owner, not "you".
    const reader = await c.agent("reader", [{ action: "task.read", project: c.project }]);
    const seenByReader = (await c.status.task(reader, t))!;
    assert.match(seenByReader.blockers.find((b) => b.basis === "policy_conflict")!.route, /made by the owner/);
    // A preference on a task the owner created and assigned is advice.
    const pref = await c.block(t, "unexplained_block", "preference", { summary: "Dora's team would rather this waited a week", resolver: "agent:dora" });
    const s2 = (await c.status.task(c.owner, t))!;
    assert.ok(!s2.blockers.some((b) => b.id === pref), "never a blocker on an owner-decided outcome");
    assert.deepEqual(s2.advice.map((b) => b.id), [pref]);
    assert.match(said(s2.lines), /Advice, not a blocker: Dora's team would rather this waited a week This outcome was decided by the owner/);
    assert.equal((await c.status.overview(c.owner, { projectId: c.project })).items.find((r) => r.taskId === t)!.advice, 1);
    assert.equal((await c.status.overview(c.owner, { projectId: c.project })).items.find((r) => r.taskId === t)!.blockers, 4);
    // On a task an agent created and assigned, the same preference is shown (as a preference, with no force).
    const lead = await c.agent("lead", []);
    const mine = (await c.projects.createTask({ commandId: cid("t"), actor: lead.id, projectId: c.project, title: "Team-made task" })).id;
    await c.projects.transitionTask({ commandId: cid("r"), actor: lead.id, taskId: mine, expectedRevision: 1, to: "ready" });
    await c.assignments.assignTask({ commandId: cid("as"), actor: lead.id, taskId: mine, owner: { kind: "agent", id: "ann" } });
    const pref2 = await c.block(mine, "unexplained_block", "preference", { summary: "Dora prefers to wait", resolver: "agent:dora" });
    const s3 = (await c.status.task(c.owner, mine))!;
    assert.deepEqual(s3.blockers.map((b) => [b.id, b.basis]), [[pref2, "preference"]]);
    assert.match(s3.blockers[0]!.route, /preference, not a boundary/);
    assert.equal(s3.advice.length, 0);
    // An owner-decided task by assignment alone: the owner assigned it to someone, so a preference is advice there too.
    const made = (await c.projects.createTask({ commandId: cid("t"), actor: lead.id, projectId: c.project, title: "Assigned by the owner" })).id;
    await c.projects.transitionTask({ commandId: cid("r"), actor: lead.id, taskId: made, expectedRevision: 1, to: "ready" });
    await c.assignments.assignTask({ commandId: cid("as"), actor: c.owner.id, taskId: made, owner: { kind: "agent", id: "ann" } });
    const pref3 = await c.block(made, "unexplained_block", "preference", { summary: "team preference", resolver: "agent:dora" });
    assert.deepEqual((await c.status.task(c.owner, made))!.advice.map((b) => b.id), [pref3]);
    // Created by the owner but handed out by an agent: the latest assignment was not the owner's, so it is not owner-decided.
    const mine2 = await c.ready("Owner's task, agent's assignment");
    await c.assignments.assignTask({ commandId: cid("as"), actor: lead.id, taskId: mine2, owner: { kind: "agent", id: "ann" } });
    const pref4 = await c.block(mine2, "unexplained_block", "preference", { summary: "another preference", resolver: "agent:dora" });
    const s5 = (await c.status.task(c.owner, mine2))!;
    assert.deepEqual([s5.advice.length, s5.blockers.map((b) => b.id)], [0, [pref4]]);
    // With no assignment at all, the creator decides: created by the owner, so advice.
    const bare = await c.ready("Owner's unassigned task");
    const pref5 = await c.block(bare, "unexplained_block", "preference", { summary: "unassigned preference", resolver: "agent:dora" });
    assert.deepEqual((await c.status.task(c.owner, bare))!.advice.map((b) => b.id), [pref5]);
    // Assigned by the owner and then reassigned by an agent: no longer the owner's outcome.
    const re = await c.work("Owner's, then reassigned", "ann");
    const ra = (await c.assignments.getAssignment(re))!;
    await c.assignments.transferTask({ commandId: cid("tr"), actor: lead.id, taskId: re, expectedRevision: ra.revision, to: { kind: "agent", id: "ben" } });
    const pref6 = await c.block(re, "unexplained_block", "preference", { summary: "late preference", resolver: "agent:dora" });
    assert.deepEqual([(await c.status.task(c.owner, re))!.advice.length, (await c.status.task(c.owner, re))!.blockers.map((b) => b.id)], [0, [pref6]]);
    // A hold opened by an agent is worded as that agent's hold.
    const agentHold = await c.blockers.openBlocker({ commandId: cid("b"), actor: lead.id, type: "manual_hold", subject: { kind: "task", id: mine }, summary: "agent hold", resolver: "owner" });
    assert.match(said((await c.status.task(c.owner, mine))!.lines), new RegExp(`held up by a hold placed by ${lead.id}`));
    void agentHold;
    // The basis must be one of the kinds; the default for a hold is the person's hold.
    await refuses("invalid_command", () => c.blockers.openBlocker({ commandId: cid("b"), actor: c.owner.id, type: "scan_failure", subject: { kind: "task", id: t }, summary: "x", resolver: "owner", basis: "vibes" as never }));
    // Other blockers' subjects reach their task: an uncertain effect, a message that could not be delivered, a ring.
    const dl = await c.block(t, "delivery_exhausted", undefined, { subject: { kind: "delivery", id: `tev:${t}:3` }, summary: "gave up" });
    const ring = await c.block(t, "circular_wait", undefined, { subject: { kind: "wait-ring", id: "wr-1" }, summary: `Circular wait among tasks ${t}, ${mine}` });
    const s4 = (await c.status.task(c.owner, t))!;
    assert.ok(s4.blockers.some((b) => b.id === dl) && s4.blockers.some((b) => b.id === ring));
    const ringSeen = (await c.status.task(reader, t))!.blockers.find((b) => b.id === ring)!;
    assert.doesNotMatch(ringSeen.summary, new RegExp(mine), "a reader who is not the owner is not shown the other tasks in a ring");
    assert.match(s4.blockers.find((b) => b.id === ring)!.summary, new RegExp(mine), "the owner is");
    // Credential-shaped text in a record is never shown.
    await c.block(t, "runtime_hold", undefined, { summary: "stuck; key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 was in the log", subject: { kind: "task", id: t } });
    assert.doesNotMatch(JSON.stringify(await c.status.task(c.owner, t)), /sk-ant-api03-abcdef/);
  });

  suite("what is shown follows the reader's rights; an unreadable task reads like a missing one", async (c) => {
    const t = await c.work("Secret plans");
    const other = await c.work("Other project", "ann", c.other);
    const none = await c.agent("none", []);
    const missing = "task-aaaaaaaaaaaaaaaaaaaa";
    assert.equal(await c.status.task(none, t), undefined);
    assert.equal(await c.status.task(none, missing), undefined);
    assert.equal(await c.status.task(c.owner, missing), undefined);
    const reader = await c.agent("reader", [{ action: "task.read", project: c.project }]);
    assert.equal(await c.status.task(reader, other), undefined, "another project");
    const s = (await c.status.task(reader, t))!;
    assert.equal(s.owner, undefined, "ownership needs assignment.read");
    assert.equal(s.execution, undefined);
    assert.deepEqual(s.withheld, ["who owns the task, who is working on it, and whether it is paused", "the tools used and the details of outside actions"]);
    assert.match(said(s.lines), /Not shown to you: who owns the task/);
    assert.doesNotMatch(JSON.stringify(s), /ann/);
    cited(s.lines);
    // A grant narrowed to another task reads nothing here.
    const narrow = await c.agent("narrow", [{ action: "task.read", project: c.project, resource: { kind: "task", id: other } }]);
    assert.equal(await c.status.task(narrow, t), undefined);
    // The assigned agent sees its own task's ownership with the task read grant only.
    const ann = await c.agent("ann2", [{ action: "task.read", project: c.project }]);
    const t2 = await c.work("Annie's", "ann2");
    assert.equal((await c.status.task(ann, t2))!.owner!.id, "ann2");
    const manager = await c.agent("manager", [{ action: "task.read", project: c.project }, { action: "assignment.read", project: c.project }]);
    assert.equal((await c.status.task(manager, t))!.owner!.id, "ann");
    // An expired grant counts for nothing.
    const brief = await c.agent("brief", [{ action: "task.read", project: c.project, expiresAt: new Date(now - MIN).toISOString() }]);
    assert.equal(await c.status.task(brief, t), undefined);
    // Callers cannot name a principal: ask takes no actor, and unknown fields are refused.
    await refuses("invalid_command", () => c.status.ask(c.owner, { kind: "task", taskId: t, actor: "owner:rob" } as never));
    await refuses("invalid_command", () => c.status.overview(c.owner, { projectId: c.project, actor: "x" } as never));
    await refuses("invalid_command", () => c.status.task(c.owner, "not-a-task"));
  });

  suite("the overview filters by project, agent and state and shows observation time, freshness and uncertainty", async (c) => {
    const w1 = await c.work("ann working", "ann"); await c.seen(w1);
    const w2 = await c.work("ann silent", "ann");
    const w3 = await c.work("ben working", "ben"); await c.seen(w3);
    const r = await c.ready("unowned");
    const o = await c.work("other project", "ann", c.other); await c.seen(o);
    await c.block(w3, "effect_uncertain", undefined);
    now += 2 * MIN;
    const all = await c.status.overview(c.owner, { projectId: c.project });
    assert.deepEqual(all.items.map((i) => i.taskId).sort(), [w1, w2, w3, r].sort());
    assert.equal(all.observedAt, at());
    assert.equal(all.partial, false);
    assert.equal(all.next, undefined);
    const row = (id: string) => all.items.find((i) => i.taskId === id)!;
    assert.equal(row(w1).execution, "working");
    assert.equal(row(w1).observation!.freshness, "fresh");
    assert.equal(row(w1).observation!.ageMs, 2 * MIN);
    assert.equal(row(w1).stale, false);
    assert.equal(row(w2).execution, "unknown");
    assert.equal(row(w2).stale, true, "a recorded-running task with no sign is flagged stale");
    assert.equal(row(w2).observation, undefined);
    assert.match(row(w2).uncertain.join(), /no sign of work/);
    assert.ok(row(w3).uncertain.includes("an action may or may not have happened"));
    assert.equal(row(r).execution, "not_assigned");
    assert.equal(all.counts.stale, 1);
    assert.deepEqual(all.counts.byState, { ready: 1, in_progress: 3 });
    cited(all.lines);
    // Filters.
    assert.deepEqual((await c.status.overview(c.owner, { projectId: c.project, agentId: "ann" })).items.map((i) => i.taskId).sort(), [w1, w2].sort());
    assert.deepEqual((await c.status.overview(c.owner, { projectId: c.project, agentId: "agent:ben" })).items.map((i) => i.taskId), [w3]);
    assert.deepEqual((await c.status.overview(c.owner, { projectId: c.project, state: "ready" })).items.map((i) => i.taskId), [r]);
    assert.deepEqual((await c.status.overview(c.owner, { projectId: c.project, execution: "unknown" })).items.map((i) => i.taskId), [w2]);
    assert.deepEqual((await c.status.overview(c.owner, { agentId: "ann" })).items.map((i) => i.taskId).sort(), [w1, w2, o].sort(), "the owner may leave the project out");
    assert.deepEqual((await c.status.overview(c.owner, { projectId: c.other })).items.map((i) => i.taskId), [o]);
    // Paging never drops tasks: a page that is full says where to continue.
    const first = await c.status.overview(c.owner, { projectId: c.project, limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.next !== undefined);
    const second = await c.status.overview(c.owner, { projectId: c.project, limit: 2, afterId: first.next! });
    assert.deepEqual([...first.items, ...second.items].map((i) => i.taskId).sort(), [w1, w2, w3, r].sort());
    // A scan that runs out of budget says so and gives a cursor instead of silently stopping.
    const tiny = c.rebuild({ scanPageSize: 1, scanPages: 2 });
    const cut = await tiny.overview(c.owner, { projectId: c.project });
    assert.equal(cut.partial, true);
    assert.ok(cut.next !== undefined);
    assert.match(said(cut.lines), /search stopped before the end of the tasks/);
    let after: string | undefined = cut.next; const walked = new Set(cut.items.map((i) => i.taskId));
    for (let i = 0; i < 20 && after !== undefined; i++) { const more = await tiny.overview(c.owner, { projectId: c.project, afterId: after }); for (const x of more.items) walked.add(x.taskId); after = more.next; }
    assert.deepEqual([...walked].sort(), [w1, w2, w3, r].sort(), "following the cursors reaches every task");
    // A blocker search that runs out of budget says so, in the overview and in a task's answer.
    await c.block(w1, "scan_failure", undefined, { summary: "one" });
    await c.block(w2, "scan_failure", undefined, { summary: "two" });
    const blind = c.rebuild({ scanPageSize: 1, scanPages: 1 });
    assert.match(said((await blind.overview(c.owner, { projectId: c.project }))!.lines), /search for blockers did not finish/);
    assert.match(said((await blind.task(c.owner, w1))!.lines), /search for blockers did not finish/);
    assert.doesNotMatch(said((await c.status.task(c.owner, w1))!.lines), /did not finish/);
    // Only the owner may leave the project out; others see what they may read.
    const reader = await c.agent("reader", [{ action: "task.read", project: c.project }]);
    await refuses("forbidden", () => c.status.overview(reader, {}));
    const seenByReader = await c.status.overview(reader, { projectId: c.project });
    assert.equal(seenByReader.items.length, 4);
    assert.ok(seenByReader.items.every((i) => i.owner === undefined && i.execution === undefined), "ownership is not shown without the right");
    assert.equal((await c.status.overview(reader, { projectId: c.project, agentId: "ann" })).items.length, 0, "an agent filter never matches what the reader cannot see");
    assert.equal((await c.status.overview(reader, { projectId: c.other })).items.length, 0);
    await refuses("invalid_command", () => c.status.overview(c.owner, { state: "weird" }));
    await refuses("invalid_command", () => c.status.overview(c.owner, { limit: 0 }));
    await refuses("invalid_command", () => c.status.overview(c.owner, { limit: 101 }));
    await refuses("invalid_command", () => c.status.overview(c.owner, { projectId: "nope" }));
    await refuses("invalid_command", () => c.status.overview(c.owner, { execution: "dancing" }));
  });

  suite("a routine status question reads records only: nothing is written, nothing is woken", async (c) => {
    const t = await c.work("Quiet");
    await c.seen(t);
    await c.waits.openWait({ commandId: cid("w"), actor: c.owner.id, taskId: await c.work("waiting"), reason: "input", resolver: "owner", summary: "which colour?", nextAction: "paint", indefinite: { owner: "rob" } });
    await c.block(t, "wait_overdue", undefined);
    await c.artifacts.publish({ commandId: cid("art"), actor: c.owner.id, name: "x", projectId: c.project, files: [{ path: "a.txt", content: Buffer.from("a") }] });
    const lastAudit = async () => (await c.storage.listAudit({ afterSeq: 0, limit: 1000 })).at(-1)!.seq;
    const counts = async () => Promise.all(["task", "assignment", "inbox-message", "wait", "blocker", "activity", "stall-evidence", "pause-gate", "stall-concern"].map(async (k) => (await c.storage.listAggregates(k, { limit: 1000 })).map((a) => `${a.id}@${a.revision}`).join(",")));
    const before = { audit: await lastAudit(), state: await counts() };
    const requests: StatusRequest[] = [
      { kind: "task", taskId: t }, { kind: "overview", projectId: c.project }, { kind: "overview" }, { kind: "changes", projectId: c.project, since: "2026-10-22T00:00:00.000Z" }, { kind: "tools", taskId: t }, { kind: "tools", projectId: c.project },
      { kind: "delivered", projectId: c.project }, { kind: "noticeboard", projectId: c.project }, { kind: "failed_events" },
    ];
    for (const r of requests) { const a = (await c.status.ask(c.owner, r))!; assert.ok(a !== undefined, r.kind); cited(a.lines); }
    assert.deepEqual({ audit: await lastAudit(), state: await counts() }, before, "the audit trail and every record are exactly as they were");
    // Nothing was woken: no inbox message exists for anyone.
    assert.equal((await c.storage.listAggregates("inbox-message", { limit: 10 })).length, 0);
    // Stateless: a fresh service answers the same (a restart changes nothing).
    const again = c.rebuild();
    assert.deepEqual((await again.task(c.owner, t))!.lines, (await c.status.task(c.owner, t))!.lines);
  });

  suite("what changed since a time, with links, and only what the reader may read", async (c) => {
    const early = await c.work("early task");
    await c.seen(early);
    now += 10 * MIN;
    const since = at();
    now += MIN;
    const late = await c.work("late task");
    await c.waits.openWait({ commandId: cid("w"), actor: c.owner.id, taskId: late, reason: "approval", resolver: "owner", summary: "ok to proceed?", nextAction: "proceed", indefinite: { owner: "rob" } });
    const bl = await c.block(late, "unexplained_block", undefined, { summary: "nobody knows" });
    const ev = await c.artifacts.publish({ commandId: cid("art"), actor: c.owner.id, name: "report", projectId: c.project, taskId: late, files: [{ path: "r.md", content: Buffer.from("# r") }] });
    const elsewhere = await c.work("other project task", "ann", c.other);
    void elsewhere;
    const ch = (await c.status.changes(c.owner, { projectId: c.project, since }))!;
    cited(ch.lines);
    const whats = ch.items.map((i) => i.what).sort();
    assert.ok(whats.includes("task created") && whats.includes("ownership") && whats.includes("wait opened") && whats.includes("blocker opened") && whats.includes("artifact"), whats.join());
    assert.ok(!ch.items.some((i) => i.cite.id === early), "an earlier change is not listed");
    assert.ok(!ch.items.some((i) => i.cite.id === elsewhere), "another project is not listed");
    assert.ok(ch.items.some((i) => i.cite.kind === "artifact" && i.cite.id === ev.id));
    assert.ok(ch.items.some((i) => i.cite.kind === "blocker" && i.cite.id === bl));
    assert.equal(ch.total, ch.items.length);
    assert.equal(ch.since, since);
    // Newest first, and a short list says how many older changes it did not list.
    const times = ch.items.map((i) => i.at);
    assert.deepEqual(times, [...times].sort().reverse());
    const small = (await c.status.changes(c.owner, { projectId: c.project, since, limit: 2 }))!;
    assert.equal(small.items.length, 2);
    assert.equal(small.total, ch.total);
    assert.match(said(small.lines), new RegExp(`${ch.total - 2} older changes? since`));
    // Later changes show up; the old since hides them.
    now += 5 * MIN;
    const p = (await c.projects.getTask(early))!;
    await c.projects.transitionTask({ commandId: cid("dn"), actor: c.owner.id, taskId: early, expectedRevision: p.revision, to: "done" });
    const ch2 = (await c.status.changes(c.owner, { projectId: c.project, since }))!;
    assert.ok(ch2.items.some((i) => i.cite.id === early && /marked done/.test(i.summary)));
    assert.equal((await c.status.changes(c.owner, { projectId: c.project, since: at() }))!.items.length, 0);
    assert.match(said((await c.status.changes(c.owner, { projectId: c.project, since: at() }))!.lines), /Nothing you may read has changed since/);
    // Permissions: a plain task reader sees tasks and waits, but not ownership, concerns or artifacts.
    const reader = await c.agent("reader", [{ action: "task.read", project: c.project }]);
    const mine = (await c.status.changes(reader, { projectId: c.project, since }))!;
    assert.ok(mine.items.length > 0);
    assert.ok(!mine.items.some((i) => i.what === "ownership" || i.what === "artifact"));
    const nobody = await c.agent("nobody", []);
    assert.equal((await c.status.changes(nobody, { projectId: c.project, since }))!.items.length, 0);
    assert.equal(await c.status.changes(c.owner, { projectId: "proj-aaaaaaaaaaaaaaaaaaaa", since }), undefined);
    // Malformed.
    await refuses("invalid_command", () => c.status.changes(c.owner, { projectId: c.project, since: "yesterday" }));
    await refuses("invalid_command", () => c.status.changes(c.owner, { projectId: c.project, since, limit: 0 }));
    // A scan cut short says so.
    const tiny = c.rebuild({ scanPageSize: 1, scanPages: 1 });
    const cutOff = (await tiny.changes(c.owner, { projectId: c.project, since }))!;
    assert.equal(cutOff.partial, true);
    assert.match(said(cutOff.lines), /search stopped before every record was read/);
  });

  suite("which tools were used, with the MCP server and capability, and what is not known", async (c) => {
    const server = await c.mcp.register(c.owner, { commandId: cid("rg"), name: "files", mode: "local", transport: "stdio", protocolRevision: "2025-06-18", sdk: SDK, launch: { command: "/opt/mcp/files-server", args: [], env: {}, secretRefs: [] }, audience: [c.project, c.other], allowed: { tools: ["read_file", "write_file"], resources: [], prompts: [] } } as never);
    const cat = await c.host("catalog");
    const snap = await c.mcp.recordCatalog(cat, { commandId: cid("sn"), serverId: server.id, protocolRevision: "2025-06-18", tools: [item("read_file"), item("write_file")] });
    await c.mcp.acceptCatalog(c.owner, { commandId: cid("ac"), serverId: server.id, revision: snap.revision, expectedRevision: 2 });
    const worker = await c.agent("coder", [{ action: "attempt.work", project: c.project }, { action: "mcp.use", project: c.project }, { action: "history.read", project: c.project }]);
    const t = await c.work("Tool user", "coder");
    const call = async (name: string, outcome?: "ok" | "error" | "uncertain") => {
      const made = await c.mcp.authorizeCall(worker, { commandId: cid("cl"), serverId: server.id, kind: "tool", name, taskId: t });
      if (outcome !== undefined) await c.mcp.recordOutcome(worker, { commandId: cid("oc"), taskId: t, callId: made.callId, outcome });
      return made.callId;
    };
    now += MIN;
    const c1 = await call("read_file", "ok");
    await call("read_file", "ok");
    await call("write_file", "error");
    const pending = await call("write_file");
    const u = await call("write_file", "uncertain");
    void c1;
    const tools = (await c.status.tools(c.owner, { taskId: t }))!;
    cited(tools.lines);
    const rf = tools.summary.find((s) => s.capability === "tool:read_file")!;
    const wf = tools.summary.find((s) => s.capability === "tool:write_file")!;
    assert.deepEqual([rf.server, rf.calls, rf.ok, rf.errors, rf.uncertain], ["files", 2, 2, 0, 0]);
    assert.deepEqual([wf.server, wf.calls, wf.ok, wf.errors, wf.uncertain], ["files", 3, 0, 1, 2], "a call with no recorded outcome and an uncertain one are both unknown");
    assert.match(said(tools.lines), /files, tool:write_file: 3 calls \(0 ok, 1 failed, 2 with an unknown outcome\)/);
    assert.match(said(tools.lines), /A tool call is activity, not progress/);
    assert.ok(tools.calls.some((x) => x.id === pending && x.outcome === "not finished" && x.uncertain));
    assert.ok(tools.calls.some((x) => x.id === u && x.protocolRevision === "2025-06-18" && x.catalogRevision === 1));
    // Project-wide, and since a time.
    const second = await c.work("another", "coder");
    const made2 = await c.mcp.authorizeCall(worker, { commandId: cid("cl"), serverId: server.id, kind: "tool", name: "read_file", taskId: second });
    await c.mcp.recordOutcome(worker, { commandId: cid("oc"), taskId: second, callId: made2.callId, outcome: "ok" });
    assert.equal((await c.status.tools(c.owner, { projectId: c.project }))!.summary.find((s) => s.capability === "tool:read_file")!.calls, 3);
    now += 10 * MIN;
    assert.equal((await c.status.tools(c.owner, { projectId: c.project, since: at() }))!.calls.length, 0);
    assert.equal((await c.status.tools(c.owner, { projectId: c.project, since: at() }))!.total, 0);
    // The ledger's outside actions for the task are listed beside the calls, with their status.
    const ledger = EffectService.withEpoch(c.storage, c.epoch, c.assignments, options);
    const eff = await ledger.intend({ commandId: cid("ef"), actor: c.owner.id, kind: "git-push", target: "origin/main?token=sk-abcdefghijklmnopqrstuvwxyz012345", input: { branch: "main" }, taskId: t });
    const listed = (await c.status.tools(c.owner, { taskId: t }))!;
    assert.deepEqual(listed.effects.map((e) => [e.id, e.kind, e.status]), [[eff.id, "git-push", "intended"]]);
    assert.doesNotMatch(JSON.stringify(listed), /sk-abcdef/);
    assert.match(said(listed.lines), /Outside action git-push on origin\/main.*: intended\./);
    assert.equal(listed.total, 6);
    // Permissions: the worker with history.read reads it; a task reader alone does not; another project's task is unreadable.
    assert.equal((await c.status.tools(worker, { taskId: t }))!.calls.length, 5);
    const reader = await c.agent("reader", [{ action: "task.read", project: c.project }]);
    assert.equal(await c.status.tools(reader, { taskId: t }), undefined);
    assert.equal((await c.status.tools(reader, { projectId: c.project }))!.calls.length, 0);
    const foreign = await c.work("foreign", "coder", c.other);
    assert.equal(await c.status.tools(worker, { taskId: foreign }), undefined);
    await refuses("invalid_command", () => c.status.tools(c.owner, {}));
    await refuses("invalid_command", () => c.status.tools(c.owner, { taskId: t, projectId: c.project }));
    await refuses("invalid_command", () => c.status.tools(c.owner, { taskId: t, since: "last week" }));
  });

  suite("what was delivered, with links; a damaged or missing artifact is reported, not counted; done is not delivered", async (c) => {
    const withArtifact = await c.work("has artifact");
    const noArtifact = await c.work("no artifact");
    for (const [id, to] of [[withArtifact, "done"], [noArtifact, "done"]] as const) {
      const rec = (await c.projects.getTask(id))!;
      await c.projects.transitionTask({ commandId: cid("dn"), actor: c.owner.id, taskId: id, expectedRevision: rec.revision, to });
    }
    const good = await c.artifacts.publish({ commandId: cid("art"), actor: c.owner.id, name: "release notes", projectId: c.project, taskId: withArtifact, files: [{ path: "notes.md", content: Buffer.from("notes") }] });
    const bad = await c.artifacts.publish({ commandId: cid("art"), actor: c.owner.id, name: "binary", projectId: c.project, files: [{ path: "app.bin", content: Buffer.from("binary content") }] });
    await c.artifacts.publish({ commandId: cid("art"), actor: c.owner.id, name: "elsewhere", projectId: c.other, files: [{ path: "x", content: Buffer.from("x") }] });
    const badEntry = (await c.artifacts.get(bad.id))!.entries[0]!;
    unlinkSync(c.blobs.pathOf(badEntry.digest));
    const d = (await c.status.delivered(c.owner, { projectId: c.project }))!;
    cited(d.lines);
    assert.deepEqual(d.artifacts.map((a) => [a.name, a.verification]).sort(), [["binary", "damaged"], ["release notes", "verified"]]);
    assert.match(said(d.lines), /Artifact binary .* its files are missing or do not match, so it is NOT counted as delivered/);
    assert.match(said(d.lines), /Artifact release notes .* its files were checked and match/);
    assert.deepEqual(d.doneWithoutArtifact.map((x) => x.taskId), [noArtifact]);
    assert.match(said(d.lines), /no artifact is recorded for it, so nothing is recorded as delivered/);
    assert.ok(d.lines.some((l) => l.cites.some((x) => x.kind === "artifact" && x.id === good.id) && l.cites.some((x) => x.kind === "task" && x.id === withArtifact)), "links to the artifact and to its task");
    // Without a verifier nothing is claimed as verified.
    const unverified = (await c.rebuild({}, { verify: false }).delivered(c.owner, { projectId: c.project }))!;
    assert.ok(unverified.artifacts.every((a) => a.verification === "not_checked"));
    assert.match(said(unverified.lines), /its files have not been checked/);
    // One task only, and since a time.
    assert.deepEqual((await c.status.delivered(c.owner, { projectId: c.project, taskId: withArtifact }))!.artifacts.map((a) => a.name), ["release notes"]);
    now += MIN;
    assert.equal((await c.status.delivered(c.owner, { projectId: c.project, since: at() }))!.artifacts.length, 0);
    // Reading artifacts needs artifact.read.
    const reader = await c.agent("reader", [{ action: "task.read", project: c.project }]);
    const noRights = (await c.status.delivered(reader, { projectId: c.project }))!;
    assert.equal(noRights.artifacts.length, 0);
    assert.match(said(noRights.lines), /Artifacts are not shown to you/);
    const viewer = await c.agent("viewer", [{ action: "task.read", project: c.project }, { action: "artifact.read", project: c.project }]);
    assert.equal((await c.status.delivered(viewer, { projectId: c.project }))!.artifacts.length, 2);
    assert.equal((await c.status.delivered(viewer, { projectId: c.other }))!.artifacts.length, 0, "another project's artifacts are not visible");
    await refuses("invalid_command", () => c.status.delivered(c.owner, { projectId: c.project, since: "soon" }));
    // A verification limit keeps a long list from reading every file.
    const few = c.rebuild({ verifyLimit: 1 });
    const limited = (await few.delivered(c.owner, { projectId: c.project }))!;
    assert.equal(limited.artifacts.filter((a) => a.verification === "not_checked").length, 1);
  });

  suite("the noticeboard summarizes assignments, the latest stand-up reports and deliverables with links, filtered by the reader's rights", async (c) => {
    const t = await c.work("Board task", "ann");
    const ready = await c.ready("Not yet assigned");
    const done = await c.work("Finished", "ann");
    const rec = (await c.projects.getTask(done))!;
    await c.projects.transitionTask({ commandId: cid("dn"), actor: c.owner.id, taskId: done, expectedRevision: rec.revision, to: "done" });
    const writer = await c.agent("ann", [{ action: "desk.write", project: c.project }, { action: "desk.read", project: c.project }]);
    const note = (title: string, extra: Record<string, unknown> = {}) => c.desks.write(writer, { commandId: cid("dk"), projectId: c.project, kind: "progress", title, body: "yesterday: parser; today: tests", visibility: "shared", status: "accepted", ...extra } as never);
    now += MIN; await note("Stand-up Monday");
    now += MIN; const newest = await note("Stand-up Tuesday");
    await note("Private thoughts", { visibility: "private" });
    await note("Draft report", { status: "draft" });
    await c.desks.write(writer, { commandId: cid("dk"), projectId: c.project, kind: "note", title: "A note", body: "x", visibility: "shared", status: "accepted" } as never);
    const art = await c.artifacts.publish({ commandId: cid("art"), actor: c.owner.id, name: "Weekly build", projectId: c.project, taskId: t, files: [{ path: "b.zip", content: Buffer.from("zip") }] });
    const b = (await c.status.noticeboard(c.owner, c.project))!;
    cited(b.lines);
    assert.deepEqual(b.assignments.map((a) => a.taskId).sort(), [t, ready].sort(), "current assignments: done work is not current");
    assert.equal(b.assignments.find((a) => a.taskId === t)!.owner, "agent:ann");
    assert.equal(b.assignments.find((a) => a.taskId === ready)!.owner, undefined);
    assert.deepEqual(b.standups.map((s) => [s.title, s.owner]), [["Stand-up Tuesday", "agent:ann"]], "one latest report per agent; private, draft and non-progress records are not reports");
    assert.deepEqual(b.standups[0]!.link, { kind: "desk-record", id: newest.id, revision: 1 });
    assert.deepEqual(b.standups[0]!.desk, { kind: "desk", id: "agent:ann" });
    assert.match(said(b.lines), /Details are on their desk/);
    assert.deepEqual(b.deliverables.map((d) => [d.name, d.artifactId, d.taskId]), [["Weekly build", art.id, t]]);
    assert.deepEqual(b.withheld, []);
    // A reader with task.read only: assignments without owners, no reports, no deliverables, and told so.
    const reader = await c.agent("reader", [{ action: "task.read", project: c.project }]);
    const r = (await c.status.noticeboard(reader, c.project))!;
    assert.ok(r.assignments.every((a) => a.owner === undefined));
    assert.deepEqual(r.standups, []);
    assert.deepEqual(r.deliverables, []);
    assert.deepEqual([...r.withheld].sort(), ["deliverables", "stand-up reports", "who owns the tasks"]);
    assert.match(said(r.lines), /Not shown to you: who owns the tasks; stand-up reports; deliverables/);
    // A reader with everything but the desk sees the rest.
    const full = await c.agent("full", [{ action: "task.read", project: c.project }, { action: "assignment.read", project: c.project }, { action: "desk.read", project: c.project }, { action: "artifact.read", project: c.project }]);
    const f = (await c.status.noticeboard(full, c.project))!;
    assert.equal(f.standups.length, 1);
    assert.equal(f.deliverables.length, 1);
    assert.equal(f.assignments.find((a) => a.taskId === t)!.owner, "agent:ann");
    // Another project and nobody.
    const nobody = await c.agent("nobody", []);
    assert.deepEqual((await c.status.noticeboard(nobody, c.project))!.assignments, []);
    assert.deepEqual((await c.status.noticeboard(full, c.other))!.assignments, []);
    assert.equal(await c.status.noticeboard(c.owner, "proj-aaaaaaaaaaaaaaaaaaaa"), undefined);
    // A scan cut short says so.
    assert.equal((await c.rebuild({ scanPageSize: 1, scanPages: 1 }).noticeboard(c.owner, c.project))!.partial, true);
  });

  suite("the failed event queue can be listed and inspected, by those who may read it", async (c) => {
    const t = await c.work("Watched", "ann");
    const reader = await c.agent("reader", [{ action: "history.read", project: c.project }, { action: "task.read", project: c.project }]);
    const dispatcher = await (async () => { await c.principals.enroll(c.owner, { commandId: cid("e"), kind: "service", name: "dispatcher", grants: [] }); return c.principals.authenticate((await c.principals.issueCredential(c.owner, "service:dispatcher")).token); })();
    const w = (await c.watches.watch(dispatcher, { commandId: cid("w"), stream: `task:${t}`, taskId: t })).id;
    await c.events.publish(dispatcher, { commandId: cid("p"), stream: `task:${t}`, kind: "file.changed", ref: { kind: "file", id: "a" } });
    const inbox = InboxService.withEpoch(c.storage, c.epoch, c.assignments, options);
    const failing = new Proxy(inbox, { get: (target, p) => (p === "receive" ? async () => { throw new Error("disk full token=sk-abcdefghijklmnopqrstuvwxyz012345"); } : typeof (target as never)[p] === "function" ? ((target as never)[p] as () => unknown).bind(target) : (target as never)[p]) });
    const broken = WatchService.withEpoch(c.storage, c.epoch, { events: c.events, inbox: failing, assignments: c.assignments, projects: c.projects }, options);
    const dispatched = await broken.dispatch(dispatcher, w) as { status: string; handlingId: string };
    assert.equal(dispatched.status, "failed");
    const q = (await c.status.failedEvents(c.owner))!;
    cited(q.lines);
    assert.equal(q.items.length, 1);
    assert.deepEqual([q.items[0]!.id, q.items[0]!.taskId, q.items[0]!.state, q.items[0]!.attempts, q.items[0]!.failedBy], [dispatched.handlingId, t, "failed", 1, "delivery"]);
    assert.match(said(q.lines), /Failed to hand over events for task .* after 1 attempt \(could not be delivered: disk full/);
    assert.doesNotMatch(JSON.stringify(q), /sk-abcdef/);
    assert.match(said(q.lines), /next retry /);
    // The task view shows the same retry beside the task.
    const s = (await c.status.task(c.owner, t))!;
    const retry = s.pending.find((p) => p.kind === "retry" && p.what === "event_handling");
    assert.ok(retry, "the failed handling is a pending retry of the task");
    // Inspect: the handling in full, the event text as outside data.
    const one = (await c.status.inspectFailedEvent(c.owner, dispatched.handlingId))!;
    cited(one.lines);
    assert.equal(one.handling.state, "failed");
    assert.match(said(one.lines), /Handling .* is failed after 1 attempt\. It could not be delivered: disk full/);
    // Who may read: the project's history readers; not an outsider; filters by project and task.
    assert.equal((await c.status.failedEvents(reader))!.items.length, 1);
    const outsider = await c.agent("outsider", [{ action: "history.read", project: c.other }]);
    assert.equal((await c.status.failedEvents(outsider))!.items.length, 0);
    assert.equal(await c.status.inspectFailedEvent(outsider, dispatched.handlingId), undefined, "unreadable reads like missing");
    assert.equal(await c.status.inspectFailedEvent(c.owner, "hnd-doesnotexist"), undefined);
    assert.equal((await c.status.failedEvents(c.owner, { projectId: c.other }))!.items.length, 0);
    assert.equal((await c.status.failedEvents(c.owner, { taskId: t }))!.items.length, 1);
    assert.equal((await c.status.failedEvents(c.owner, { projectId: c.project, limit: 1 }))!.items.length, 1);
    await refuses("invalid_command", () => c.status.failedEvents(c.owner, { limit: 500 }));
    await refuses("invalid_command", () => c.status.inspectFailedEvent(c.owner, "bad id!"));
    // An empty queue says so; no event service wired: no queue.
    await broken.settle(c.owner, { commandId: cid("st"), handlingId: dispatched.handlingId, outcome: "abandoned" });
    assert.match(said((await c.status.failedEvents(c.owner))!.lines), /queue is empty/);
    assert.equal(await c.rebuild({}, { watch: false }).failedEvents(c.owner), undefined);
    assert.equal(await c.rebuild({}, { watch: false }).inspectFailedEvent(c.owner, dispatched.handlingId), undefined);
  });

  suite("stall concerns are shown as suspected, apart from confirmed ones", async (c) => {
    const t = await c.work("Looping", "ann");
    const h = await c.host("h1");
    const a = (await c.assignments.getAssignment(t))!;
    await c.hosts.announce(h, { commandId: cid("an"), capabilities: { os: "linux", arch: "x64", harnesses: [], isolation: [], tools: [], workspaces: [] } });
    for (let i = 0; i < 6; i++) await c.stall.report(h, { commandId: cid("rp"), taskId: t, generation: a.generation, event: { type: "step", label: "run tests", actionKey: "tests:all" } });
    await c.stall.scan(c.owner);
    let s = (await c.status.task(c.owner, t))!;
    assert.equal(s.concerns.suspected.length, 1);
    assert.equal(s.concerns.confirmed.length, 0);
    assert.match(said(s.lines), /Suspected, not confirmed: the same action \("tests:all"\) repeated at least 6 times/);
    const concern = (await c.stall.list(c.owner, { taskId: t })).items[0]!;
    await c.stall.decide(c.owner, { commandId: cid("dc"), concernId: concern.id, expectedRevision: concern.revision, decision: "confirm", reason: "it is looping" });
    s = (await c.status.task(c.owner, t))!;
    assert.deepEqual([s.concerns.suspected.length, s.concerns.confirmed.length], [0, 1]);
    assert.match(said(s.lines), /Confirmed problem:/);
    cited(s.lines);
  });

  suite("the request dispatcher answers each kind, refuses unknown ones and returns nothing for what is missing", async (c) => {
    const t = await c.work("Dispatch");
    await refuses("invalid_command", () => c.status.ask(c.owner, { kind: "weather" } as never));
    await refuses("invalid_command", () => c.status.ask(c.owner, null as never));
    await refuses("invalid_command", () => c.status.ask(c.owner, { kind: "changes", projectId: c.project, since: "2026-10-22T00:00:00.000Z", extra: 1 } as never));
    assert.equal(await c.status.ask(c.owner, { kind: "task", taskId: "task-aaaaaaaaaaaaaaaaaaaa" }), undefined);
    assert.equal(await c.status.ask(c.owner, { kind: "failed_event", handlingId: "hnd-zzzz" }), undefined);
    const a = (await c.status.ask(c.owner, { kind: "task", taskId: t }))!;
    assert.equal(a.observedAt, at());
    cited(a.lines);
  });


  suite("a reader denied tools and outside actions gets no details of them, and is told so; a done task does not look clean to them", async (c) => {
    const t = await c.work("Deploys", "ann");
    const secretish = "deploy to prod.example.com failed: connection refused by 10.1.2.3";
    const made = await EffectService.withEpoch(c.storage, c.epoch, c.assignments, options).intend({ commandId: cid("ef"), actor: c.owner.id, kind: "deploy", target: "prod", input: {}, taskId: t });
    const eff = await c.block(t, "effect_uncertain", undefined, { summary: secretish, subject: { kind: "effect", id: made.id } });
    const dl = await c.block(t, "delivery_exhausted", undefined, { summary: "gave up sending to queue-7: timeout", subject: { kind: "delivery", id: `tev:${t}:2` } });
    void eff; void dl;
    const reader = await c.agent("reader", [{ action: "task.read", project: c.project }]);
    const full = await c.agent("fullreader", [{ action: "task.read", project: c.project }, { action: "history.read", project: c.project }]);
    const seen = (await c.status.task(reader, t))!;
    assert.doesNotMatch(JSON.stringify(seen), /prod\.example|10\.1\.2\.3|queue-7/);
    assert.equal(seen.blockers.length, 2);
    assert.ok(seen.blockers.every((b) => b.masked));
    assert.ok(seen.withheld.includes("the tools used and the details of outside actions"));
    assert.match(said(seen.lines), /An outside action or message for this task has a problem; the details are not shown to you/);
    const allowed = (await c.status.task(full, t))!;
    assert.match(JSON.stringify(allowed), /prod\.example\.com/);
    assert.ok(!allowed.withheld.includes("the tools used and the details of outside actions"));
    assert.match(JSON.stringify(await c.status.task(c.owner, t)), /queue-7/);
    // The same in what changed.
    const ch = (await c.status.changes(reader, { projectId: c.project, since: "2026-10-22T00:00:00.000Z" }))!;
    assert.doesNotMatch(JSON.stringify(ch), /prod\.example|queue-7/);
    assert.match(JSON.stringify(await c.status.changes(full, { projectId: c.project, since: "2026-10-22T00:00:00.000Z" })), /prod\.example\.com/);
    // Resolving a masked blocker does not leak its resolution; the view carries an opaque ID, not the one built from the subject.
    const resolved = await c.blockers.openBlocker({ commandId: cid("b"), actor: c.owner.id, type: "effect_uncertain", subject: { kind: "effect", id: made.id }, summary: "x", resolver: "owner" }).catch(() => undefined);
    void resolved;
    const toResolve = (await c.blockers.openFor("delivery_exhausted", { kind: "delivery", id: `tev:${t}:2` }))!;
    await c.blockers.resolveBlocker({ commandId: cid("rs"), actor: c.owner.id, blockerId: toResolve.id, expectedRevision: toResolve.revision, resolution: "checked repo X, the push did happen" });
    const after = (await c.status.changes(reader, { projectId: c.project, since: "2026-10-22T00:00:00.000Z" }))!;
    assert.doesNotMatch(JSON.stringify(after), /repo X|push did happen/);
    assert.match(said(after.lines), /A blocker about an outside action was resolved\./);
    assert.match(JSON.stringify(await c.status.changes(full, { projectId: c.project, since: "2026-10-22T00:00:00.000Z" })), /repo X/);
    const rawIds = [eff, dl];
    for (const id of rawIds) assert.doesNotMatch(JSON.stringify(seen), new RegExp(id));
    assert.ok(seen.blockers.every((b) => /^blk-[0-9a-f]{20}$/.test(b.id)));
    // A failed delivery's error is not shown to a reader denied tools.
    const fresh = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.project, title: "fresh" })).id;
    const claims = await c.storage.claimDeliveries({ epoch: c.epoch, destination: "task-events", claimant: "tester", now: at(), leaseMs: 60_000, limit: 100 });
    const mine = claims.find((x) => x.aggregate.id === fresh)!;
    await c.storage.retryDelivery({ epoch: c.epoch, deliveryId: mine.deliveryId, claimToken: mine.claimToken, nextAttemptAt: new Date(now + MIN).toISOString(), reason: "queue-9 refused: secretdest", at: at() });
    const retryOwn = (await c.status.task(c.owner, fresh))!;
    const retryReader = (await c.status.task(reader, fresh))!;
    assert.match(said(retryOwn.lines), /secretdest/);
    assert.match(said(retryReader.lines), /has not gone out yet: 1 attempt so far, next try/);
    assert.doesNotMatch(JSON.stringify(retryReader), /secretdest|queue-9/);
    // A done task with a tool call of unknown outcome: the owner is told which; the reader is told that an outcome is unknown, without the tool.
    const server = await c.mcp.register(c.owner, { commandId: cid("rg"), name: "deployer", mode: "local", transport: "stdio", protocolRevision: "2025-06-18", sdk: SDK, launch: { command: "/opt/mcp/d", args: [], env: {}, secretRefs: [] }, audience: [c.project], allowed: { tools: ["push_prod"], resources: [], prompts: [] } } as never);
    const cat = await c.host("catalog");
    const snap = await c.mcp.recordCatalog(cat, { commandId: cid("sn"), serverId: server.id, protocolRevision: "2025-06-18", tools: [item("push_prod")] });
    await c.mcp.acceptCatalog(c.owner, { commandId: cid("ac"), serverId: server.id, revision: snap.revision, expectedRevision: 2 });
    const worker = await c.agent("pusher", [{ action: "attempt.work", project: c.project }, { action: "mcp.use", project: c.project }]);
    const d = await c.ready("Pushes");
    await c.mcp.authorizeCall(worker, { commandId: cid("cl"), serverId: server.id, kind: "tool", name: "push_prod", taskId: d });
    const rec = (await c.projects.getTask(d))!;
    await c.projects.transitionTask({ commandId: cid("ip"), actor: c.owner.id, taskId: d, expectedRevision: rec.revision, to: "in_progress" });
    await c.projects.transitionTask({ commandId: cid("dn"), actor: c.owner.id, taskId: d, expectedRevision: rec.revision + 1, to: "done" });
    const own = (await c.status.task(c.owner, d))!;
    const theirs = (await c.status.task(reader, d))!;
    assert.deepEqual([own.completion, theirs.completion], ["done_with_open_doubts", "done_with_open_doubts"]);
    assert.match(said(own.lines), /deployer \(tool:push_prod\)/);
    assert.doesNotMatch(JSON.stringify(theirs), /deployer|push_prod/);
    const generic = theirs.lines.find((l) => /an action's outcome is not known/.test(l.text))!;
    assert.deepEqual(generic.cites, [{ kind: "task", id: d }]);
    assert.ok(theirs.withheld.includes("the tools used and the details of outside actions"));
  });

  suite("the overview says when parts were left out; a dependency on something unreadable is said to be unseen; old stand-up reports are flagged", async (c) => {
    const w = await c.work("Mine", "ann");
    const reader = await c.agent("reader", [{ action: "task.read", project: c.project }]);
    const own = await c.status.overview(c.owner, { projectId: c.project });
    assert.deepEqual(own.withheld, []);
    const theirs = await c.status.overview(reader, { projectId: c.project });
    assert.deepEqual(theirs.withheld, ["who owns the tasks, whether work is happening, and pauses"]);
    assert.match(said(theirs.lines), /Not shown to you: who owns the tasks/);
    assert.equal(theirs.items[0]!.stale, false);
    void w;
    // A dependency on a task the reader cannot read.
    const pre = await c.ready("Private prerequisite");
    const dependent = await c.ready("Dependent");
    await c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: dependent, prerequisiteId: pre });
    const narrow = await c.agent("narrow", [{ action: "task.read", project: c.project, resource: { kind: "task", id: dependent } }]);
    const s = (await c.status.task(narrow, dependent))!;
    assert.deepEqual(s.pending, [{ kind: "hidden_dependency" }]);
    const tiny = (await c.rebuild({ scanPageSize: 1, scanPages: 1 }).task(c.owner, dependent))!;
    assert.match(said(tiny.lines), /The dependency check did not finish/);
    assert.doesNotMatch(said(tiny.lines), /something you cannot see/);
    assert.match(said(s.lines), /It is waiting on something you cannot see\./);
    assert.doesNotMatch(JSON.stringify(s), /Private prerequisite/);
    // Stand-up reports age.
    const writer = await c.agent("ann", [{ action: "desk.write", project: c.project }, { action: "desk.read", project: c.project }]);
    await c.desks.write(writer, { commandId: cid("dk"), projectId: c.project, kind: "progress", title: "Stand-up", body: "x", visibility: "shared", status: "accepted" } as never);
    let b = (await c.status.noticeboard(c.owner, c.project))!;
    assert.equal(b.standups[0]!.stale, false);
    now += 37 * 60 * MIN;
    b = (await c.status.noticeboard(c.owner, c.project))!;
    assert.equal(b.standups[0]!.stale, true);
    assert.match(said(b.lines), /Stand-up \(.*\), which is old\./);
    // Plain words: no generations, rounds or bare freshness labels.
    const all = said((await c.status.task(c.owner, w))!.lines) + said(own.lines);
    assert.doesNotMatch(all, /generation|round \d|\(fresh\)|\(stale\)/);
  });

  suite("blocker bases: stored when stated, the default otherwise, replayed unchanged", async (c) => {
    const t = await c.work("Basis");
    const first = await c.blockers.openBlocker({ commandId: "bb-1", actor: c.owner.id, type: "scan_failure", subject: { kind: "task", id: t }, summary: "x", resolver: "owner", basis: "policy_conflict" });
    const again = await c.blockers.openBlocker({ commandId: "bb-1", actor: c.owner.id, type: "scan_failure", subject: { kind: "task", id: t }, summary: "x", resolver: "owner", basis: "policy_conflict" });
    assert.deepEqual([again.id, again.replayed], [first.id, true]);
    await refuses("command_conflict", () => c.blockers.openBlocker({ commandId: "bb-1", actor: c.owner.id, type: "scan_failure", subject: { kind: "task", id: t }, summary: "x", resolver: "owner", basis: "technical" }));
    assert.equal((await c.blockers.getBlocker(first.id))!.basis, "policy_conflict");
    const plain = await c.blockers.openBlocker({ commandId: "bb-2", actor: c.owner.id, type: "manual_hold", subject: { kind: "task", id: t }, summary: "hold", resolver: "owner" });
    assert.equal((await c.blockers.getBlocker(plain.id))!.basis, undefined, "an unstated basis is not stored");
    assert.equal((await c.status.task(c.owner, t))!.blockers.find((b) => b.id === plain.id)!.basis, "owner_hold");
  });

  suite("the owner sees the questions agents have put to them, in the agent's own words and with the task and wait; nobody else sees them (card U12e)", async (c) => {
    const q = { inquiryId: "inq-1", asker: "agent:ann", question: "Postgres or SQLite?", askedAt: "2026-10-22T09:00:00.000Z", revision: 2, task: { id: "task-1", title: "Pick the store", projectName: "Alpha" }, wait: { summary: "waiting for the choice of database", nextAction: "build on it", deadline: "2026-10-25T00:00:00.000Z" } };
    let items = [q];
    const status = c.rebuild({}, { ownerQuestions: { ownerQuestions: async (_o, page) => ({ items: items.slice(0, page?.limit ?? 10), ...(items.length > (page?.limit ?? 10) ? { next: "more" } : {}) }) } });
    const got = (await status.ask(c.owner, { kind: "owner_questions" }))!;
    assert.equal(got.lines.length, 1);
    assert.match(got.lines[0]!.text, /agent:ann asks about "Pick the store" \(Alpha\)/);
    assert.match(got.lines[0]!.text, /"Postgres or SQLite\?"/);
    assert.match(got.lines[0]!.text, /Your answer ends the wait: waiting for the choice of database\. It is due 2026-10-25/);
    assert.deepEqual(got.lines[0]!.cites.map((x) => [x.kind, x.id]), [["inquiry", "inq-1"], ["task", "task-1"]]);
    items = [];
    assert.match((await status.ask(c.owner, { kind: "owner_questions" }))!.lines[0]!.text, /No agent is waiting for your answer/);
    items = [q, { ...q, inquiryId: "inq-2" }];
    const cut = (await status.ask(c.owner, { kind: "owner_questions", limit: 1 }))!;
    assert.equal(cut.lines.length, 2);
    assert.match(cut.lines[1]!.text, /more questions than shown/);
    // Not the owner, or nothing wired: nothing is shown. A bad limit or key is refused.
    const reader = await c.agent("eve", [{ action: "task.read", project: "*" }]);
    assert.equal(await status.ask(reader, { kind: "owner_questions" }), undefined);
    assert.equal(await c.rebuild().ask(c.owner, { kind: "owner_questions" }), undefined);
    await assert.rejects(status.ask(c.owner, { kind: "owner_questions", limit: 0 }));
    await assert.rejects(status.ask(c.owner, { kind: "owner_questions", extra: 1 } as never));
  });
}
