import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { HostService } from "../hosts/index.js";
import { ContractService } from "../planning/contracts.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { Difficulty } from "../planning/contracts.js";
import { StallService, assessStall, DEFAULT_THRESHOLDS, type StallEvent, type StallOptions } from "./index.js";

after(stopServer);

const T0 = Date.parse("2026-10-22T08:00:00.000Z");
const MIN = 60_000;
let now = T0;
const at = (): string => new Date(now).toISOString();
const options = { clock: at, pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx {
    stall: StallService; owner: Principal; project: string; other: string;
    projects: ProjectService; assignments: AssignmentService; waits: WaitService; agents: AgentService; contracts: ContractService;
    storage: import("../storage/types.js").ControllerStorage;
    service(extra?: StallOptions): StallService;
    host(name: string, project?: string): Promise<Principal>;
    plain(name: string, grants?: Grant[]): Promise<Principal>;
    hbAgent(name: string, extra?: Record<string, unknown>): Promise<{ id: string; principal: Principal }>;
    /** A task in progress under `owner`, with an active attempt. */
    work(c?: { owner?: string; difficulty?: Difficulty; budget?: { maxMinutes?: number; maxCost?: number }; requiredEvidence?: string[]; project?: string }): Promise<string>;
    send(by: Principal, taskId: string, event: StallEvent, generation?: number): ReturnType<StallService["report"]>;
    principals: PrincipalService;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>, extra: StallOptions = {}) =>
    test(`${backend.name}: ${name}`, async () => {
      now = T0;
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const grants = GrantService.withEpoch(world.storage, epoch, options);
        const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const waits = WaitService.withEpoch(world.storage, epoch, assignments, options);
        const agents = AgentService.withEpoch(world.storage, epoch, options);
        const contracts = ContractService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
        const other = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Q" })).id;
        const service = (more: StallOptions = {}) => StallService.withEpoch(world.storage, epoch, assignments, waits, { ...options, hostStaleAfterMs: 60_000, ...extra, ...more });
        const stall = service();
        const host: Ctx["host"] = async (nm, proj = project) => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: nm, grants: [{ action: "attempt.work", project: proj }] });
          return principals.authenticate((await principals.issueCredential(owner, `host:${nm}`)).token);
        };
        const plain: Ctx["plain"] = async (nm, given = []) => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: given });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        };
        const hbAgent: Ctx["hbAgent"] = async (friendlyName, more = {}) => {
          const created = await agents.create(owner, { commandId: cid("a"), friendlyName, ...more });
          return { id: created.id, principal: await principals.authenticate((await principals.issueCredential(owner, `agent:${created.id}`)).token) };
        };
        const work: Ctx["work"] = async (c = {}) => {
          const proj = c.project ?? project;
          const id = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: proj, title: "work" })).id;
          if (c.difficulty !== undefined || c.budget !== undefined || c.requiredEvidence !== undefined)
            await contracts.setContract(owner, { commandId: cid("c"), taskId: id, expectedVersion: 0, ...(c.difficulty === undefined ? {} : { difficulty: c.difficulty }), ...(c.budget === undefined ? {} : { budget: c.budget }), ...(c.requiredEvidence === undefined ? {} : { requiredEvidence: c.requiredEvidence }) });
          await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: id, expectedRevision: 1, to: "ready" });
          const ownerRef = { kind: "agent", id: c.owner ?? "ann" };
          await assignments.assignTask({ commandId: cid("as"), actor: owner.id, taskId: id, owner: ownerRef });
          const a = (await assignments.getAssignment(id))!;
          await assignments.admitAttempt({ commandId: cid("ad"), actor: owner.id, taskId: id, expectedRevision: a.revision, generation: a.generation, owner: ownerRef });
          const t = (await projects.getTask(id))!;
          await projects.transitionTask({ commandId: cid("ip"), actor: owner.id, taskId: id, expectedRevision: t.revision, to: "in_progress" });
          return id;
        };
        const send: Ctx["send"] = (by, taskId, event, generation = 1) => stall.report(by, { commandId: cid("rep"), taskId, generation, event });
        void grants;
        await body({ stall, owner, project, other, projects, assignments, waits, agents, contracts, storage: world.storage, service, host, plain, hbAgent, work, send, principals });
      } finally { await world.close(); }
    });
  const step = (label: string, actionKey?: string): StallEvent => ({ type: "step", label, ...(actionKey === undefined ? {} : { actionKey }) });
  const kinds = async (c: Ctx, taskId: string): Promise<string[]> => (await c.stall.assess(c.owner, taskId))!.concerns.map((x) => x.kind).sort();

  suite("a long legitimate job differs from a loop and from a dead worker", async (c) => {
    const h = await c.host("h1");
    // A long job: a hard task whose request has been open 30 minutes, while the worker keeps reporting different steps and the job is running.
    const long = await c.work({ difficulty: "hard" });
    await c.send(h, long, { type: "request_started", requestId: "r1" });
    await c.send(h, long, { type: "job", status: "running" });
    for (let i = 0; i < 6; i++) { now += 5 * MIN; await c.send(h, long, step(`compile module ${i}`, `compile:${i}`)); }
    let a = (await c.stall.assess(c.owner, long))!;
    assert.equal(a.status, "long_running");
    assert.deepEqual(a.concerns, []);
    assert.ok(a.signals.requestOpenMs! >= 30 * MIN);
    // A loop: the same action over and over with no acceptance evidence. One short of the medium threshold (6) is fine.
    const loop = await c.work();
    for (let i = 0; i < 5; i++) { now += MIN; await c.send(h, loop, step("run tests", "tests:all")); }
    assert.equal((await c.stall.assess(c.owner, loop))!.status, "healthy");
    now += MIN; await c.send(h, loop, step("run tests", "tests:all"));
    a = (await c.stall.assess(c.owner, loop))!;
    assert.deepEqual([a.status, a.concerns.map((x) => x.kind)], ["suspected", ["loop"]]);
    assert.match(a.concerns[0]!.detail, /repeated at least 6 times since the last acceptance evidence/);
    // A dead worker: it reported once and then nothing; it is not a loop and not a long request.
    const dead = await c.work();
    await c.send(h, dead, step("start", "start"));
    now += 19 * MIN;
    assert.deepEqual(await kinds(c, dead), [], "19 minutes of quiet is under the medium threshold");
    now += 2 * MIN;
    assert.deepEqual(await kinds(c, dead), ["silent"]);
    // The three are different verdicts; the long job stayed healthy while the others were flagged.
    a = (await c.stall.assess(c.owner, long))!;
    assert.deepEqual([a.status, a.concerns], ["long_running", []], "the long job is still a long job while the loop and the dead worker are flagged");
    // A task where an open request is the only thing that happened is a stuck request, not a long job.
    const stuck = await c.work({ difficulty: "easy" });
    await c.send(h, stuck, { type: "request_started", requestId: "r9" });
    now += 6 * MIN;
    assert.deepEqual(await kinds(c, stuck), ["stuck_request"]);
    now += 5 * MIN;
    assert.deepEqual(await kinds(c, stuck), ["silent", "stuck_request"]);
  });

  suite("new acceptance evidence answers a loop; the same actions after it are counted afresh", async (c) => {
    const h = await c.host("h1");
    const t = await c.work();
    for (let i = 0; i < 5; i++) await c.send(h, t, step("edit", "edit:a"));
    await c.send(h, t, { type: "evidence", item: "test-report-1" });
    await c.send(h, t, step("edit", "edit:a"));
    assert.deepEqual(await kinds(c, t), [], "five repeats before the evidence do not count with the one after");
    for (let i = 0; i < 5; i++) await c.send(h, t, step("edit", "edit:a"));
    assert.deepEqual(await kinds(c, t), ["loop"]);
    // The same error repeating is its own concern, with its own (lower) threshold.
    const e = await c.work();
    for (let i = 0; i < 4; i++) await c.send(h, e, { type: "error", errorClass: "ENOSPC", actionKey: "write:/tmp" });
    assert.deepEqual(await kinds(c, e), []);
    await c.send(h, e, { type: "error", errorClass: "ENOSPC", actionKey: "write:/tmp" });
    assert.deepEqual(await kinds(c, e), ["repeated_errors"]);
    // Different errors are not repeats.
    const f = await c.work();
    for (let i = 0; i < 8; i++) await c.send(h, f, { type: "error", errorClass: `E${i}` });
    assert.deepEqual(await kinds(c, f), []);
  });

  suite("a stale timestamp is never the sole permission to take over", async (c) => {
    const h = await c.host("h1");
    const t = await c.work();
    await c.send(h, t, step("start"));
    const before = JSON.stringify([await c.assignments.getAssignment(t), (await c.projects.getTask(t))!.revision]);
    now += 25 * MIN;
    // Silent for 25 minutes, but a host that was never heard from is not a second channel: no proposal, and never a permission.
    let a = (await c.stall.assess(c.owner, t))!;
    assert.equal(a.concerns[0]!.kind, "silent");
    assert.deepEqual([a.signals.host?.freshness, a.takeover.permitted, a.takeover.basis], ["unknown", false, "insufficient"]);
    // A silent agent that reports directly, with no host at all, never gets even a proposal.
    const t2 = await c.work();
    const ann = await c.plain("ann", [{ action: "attempt.work", project: c.project }]);
    await c.send(ann, t2, step("start"));
    now += 25 * MIN;
    a = (await c.stall.assess(c.owner, t2))!;
    assert.deepEqual([a.status, a.takeover.permitted, a.takeover.basis, a.signals.host], ["suspected", false, "insufficient", undefined]);
    assert.match(a.takeover.note, /not permission/);
    await c.stall.scan(c.owner);
    assert.equal(JSON.stringify([await c.assignments.getAssignment(t), (await c.projects.getTask(t))!.revision]), before, "a scan changes no assignment and no task");
  });

  suite("the host channel: only a revoked host identity (not a stale timestamp) allows a takeover to be proposed, and it is never permitted", async (c) => {
    const h = await c.host("h1");
    const hosts = HostService.withEpoch(c.storage, c.projects.epoch, c.assignments, { ...options, staleAfterMs: 60_000 });
    await hosts.announce(h, { commandId: cid("an"), capabilities: { os: "linux", arch: "x64", harnesses: [], isolation: [], tools: [], workspaces: [] } });
    await hosts.heartbeat(h, { commandId: cid("hb"), sequence: 1 });
    const t = await c.work();
    await c.send(h, t, step("start"));
    now += 25 * MIN;
    let a = (await c.stall.assess(c.owner, t))!;
    assert.deepEqual([a.concerns.map((x) => x.kind), a.signals.host?.freshness, a.takeover.basis, a.takeover.permitted], [["silent"], "stale", "insufficient", false]);
    // Host and worker both quiet is what a network partition looks like too: timestamps alone never give a basis.
    // The host heartbeats (it is alive and reachable) while the worker is silent: still a concern, but no proposal to take over.
    await hosts.heartbeat(h, { commandId: cid("hb"), sequence: 2 });
    a = (await c.stall.assess(c.owner, t))!;
    assert.deepEqual([a.concerns.map((x) => x.kind), a.signals.host?.freshness, a.takeover.basis], [["silent"], "fresh", "insufficient"]);
    // A stale host with a worker that is still reporting is not silent at all.
    now += 25 * MIN;
    await c.send(h, t, step("still going"));
    a = (await c.stall.assess(c.owner, t))!;
    assert.deepEqual([a.status, a.signals.host?.freshness, a.takeover.basis], ["healthy", "stale", "insufficient"]);
    // A revoked host counts as gone.
    now += 25 * MIN;
    const stored = (await c.principals.get(h.id))!;
    await c.principals.disable(c.owner, { commandId: cid("dis"), principalId: h.id, expectedRevision: stored.revision });
    await hosts.heartbeat(h, { commandId: cid("hb"), sequence: 3 }).catch(() => undefined);
    a = (await c.stall.assess(c.owner, t))!;
    assert.deepEqual([a.signals.host?.identity, a.takeover.basis, a.takeover.permitted], ["revoked", "may_be_proposed", false]);
  });

  suite("the signals: request duration, last step, repeated actions and errors, job status, budget and acceptance evidence", async (c) => {
    const h = await c.host("h1");
    const t = await c.work({ budget: { maxMinutes: 60, maxCost: 500 }, requiredEvidence: ["unit tests", "review"] });
    await c.send(h, t, { type: "request_started", requestId: "req-1" });
    now += 3 * MIN;
    let a = (await c.stall.assess(c.owner, t))!;
    assert.equal(a.signals.requestOpenMs, 3 * MIN);
    await c.send(h, t, { type: "request_started", requestId: "req-1" });
    assert.equal((await c.stall.assess(c.owner, t))!.signals.requestOpenMs, 3 * MIN, "repeating the start of the open request does not make it younger");
    await c.send(h, t, { type: "request_finished", requestId: "req-1", outcome: "ok" });
    await c.send(h, t, step("read the failing test", "read:t1"));
    await c.send(h, t, step("read the failing test", "read:t1"));
    await c.send(h, t, { type: "error", errorClass: "TypeError", actionKey: "run:t1" });
    await c.send(h, t, { type: "job", status: "running" });
    await c.send(h, t, { type: "spend", minutes: 12, cost: 90 });
    await c.send(h, t, { type: "evidence", item: "unit tests: 40 passed" });
    await c.send(h, t, { type: "evidence", item: "unit tests: 40 passed" });
    a = (await c.stall.assess(c.owner, t))!;
    assert.equal(a.signals.requestOpenMs, undefined);
    assert.equal(a.signals.lastRequestMs, 3 * MIN);
    assert.equal(a.signals.lastStep!.label, "read the failing test");
    assert.deepEqual([a.signals.job!.status, a.signals.spend, a.signals.budget, a.signals.evidenceCount, a.signals.requiredEvidence], ["running", { minutes: 12, cost: 90 }, { maxMinutes: 60, maxCost: 500 }, 1, 2], "the same evidence item twice counts once");
    assert.equal(a.signals.topAction, undefined, "the earlier steps came before the evidence");
    await c.send(h, t, step("read the failing test", "read:t1"));
    assert.deepEqual(( await c.stall.assess(c.owner, t))!.signals.topAction, { key: "read:t1", count: 1 });
    const e = (await c.stall.evidence(c.owner, t))!;
    assert.deepEqual([e.steps, e.evidenceTotal, e.reportedBy], [3, 1, h.id]);
    // Budget exhaustion is a concern of its own, with how much evidence exists.
    await c.send(h, t, { type: "spend", minutes: 60 });
    a = (await c.stall.assess(c.owner, t))!;
    assert.deepEqual(a.concerns.map((x) => x.kind), ["budget"]);
    assert.match(a.concerns[0]!.detail, /budget is used up \(60 minutes\)/);
    await refuses("invalid_command", () => c.send(h, t, { type: "spend", minutes: 10 }), (x) => assert.match(x.message, /cannot go down/));
    const costly = await c.work({ budget: { maxCost: 100 } });
    await c.send(h, costly, { type: "spend", cost: 100 });
    assert.deepEqual(await kinds(c, costly), ["budget"]);
  });

  suite("thresholds depend on difficulty and can be configured", async (c) => {
    const h = await c.host("h1");
    const ids: Record<string, string> = {};
    for (const level of ["trivial", "medium", "expert"] as const) { ids[level] = await c.work({ difficulty: level }); await c.send(h, ids[level]!, step("go")); }
    ids["none"] = await c.work(); await c.send(h, ids["none"], step("go"));
    now += 15 * MIN;
    assert.deepEqual(await kinds(c, ids["trivial"]!), ["silent"], "trivial: 5 minutes");
    assert.deepEqual(await kinds(c, ids["medium"]!), []);
    assert.deepEqual(await kinds(c, ids["expert"]!), []);
    assert.deepEqual(await kinds(c, ids["none"]!), [], "no stated difficulty is medium");
    assert.equal((await c.stall.assess(c.owner, ids["none"]!))!.difficulty, "medium");
    assert.equal((await c.stall.assess(c.owner, ids["expert"]!))!.difficulty, "expert");
    now += 10 * MIN;
    assert.deepEqual(await kinds(c, ids["medium"]!), ["silent"]);
    assert.deepEqual(await kinds(c, ids["expert"]!), []);
    now += 70 * MIN;
    assert.deepEqual(await kinds(c, ids["expert"]!), ["silent"]);
    // Ordered by difficulty, and the table is what is applied.
    assert.ok(DEFAULT_THRESHOLDS.trivial.silenceMs < DEFAULT_THRESHOLDS.medium.silenceMs && DEFAULT_THRESHOLDS.medium.silenceMs < DEFAULT_THRESHOLDS.expert.silenceMs);
    // Configured thresholds win; nonsense is refused.
    const tight = c.service({ thresholds: { medium: { silenceMs: 2 * MIN } } });
    assert.deepEqual((await tight.assess(c.owner, ids["medium"]!))!.concerns.map((x) => x.kind), ["silent"]);
    assert.throws(() => c.service({ thresholds: { medium: { repeatedActions: 1 } } }), DomainError);
    assert.throws(() => c.service({ thresholds: { medium: { silenceMs: 10 } } }), DomainError);
    assert.throws(() => c.service({ hostStaleAfterMs: 5 }), DomainError);
  });

  suite("the scan runs for the owner, for a service holding recovery.stall-scan or recovery.read everywhere, and for no one else", async (c) => {
    const service = async (name: string, grants: Grant[]) => {
      await c.principals.enroll(c.owner, { commandId: cid("e"), kind: "service", name, grants });
      return c.principals.authenticate((await c.principals.issueCredential(c.owner, `service:${name}`)).token);
    };
    const narrow = await service("scanner", [{ action: "recovery.stall-scan", project: "*" }]);
    const broad = await service("reader", [{ action: "recovery.read", project: "*" }]);
    const scoped = await service("scoped", [{ action: "recovery.stall-scan", project: c.project }]);
    const bare = await service("bare", []);
    assert.equal((await c.stall.scan(narrow)).checked >= 0, true);
    assert.equal((await c.stall.scan(broad)).checked >= 0, true);
    await refuses("forbidden", () => c.stall.scan(scoped));
    await refuses("forbidden", () => c.stall.scan(bare));
    await refuses("forbidden", async () => c.stall.scan(await c.plain("ann")));
  });

  suite("a task that waits on purpose is not suspected, and a concern clears when the wait opens", async (c) => {
    const h = await c.host("h1");
    const t = await c.work();
    await c.send(h, t, step("start"));
    now += 30 * MIN;
    await c.stall.scan(c.owner);
    assert.equal((await c.stall.list(c.owner)).items.length, 1);
    await c.waits.openWait({ commandId: cid("w"), actor: c.owner.id, taskId: t, reason: "approval", resolver: "owner", summary: "may I delete the old beds?", nextAction: "delete them", indefinite: { owner: "rob" } });
    now += 3 * 3_600_000;
    const a = (await c.stall.assess(c.owner, t))!;
    assert.deepEqual([a.status, a.concerns], ["waiting", []]);
    const report = await c.stall.scan(c.owner);
    assert.equal(report.cleared, 1);
    const cleared = (await c.stall.list(c.owner, { state: "cleared" })).items;
    assert.deepEqual([cleared.length, cleared[0]!.clearedBecause], [1, "the task is waiting on purpose"]);
    assert.equal((await c.stall.list(c.owner)).items.length, 0);
  });

  suite("a task that is not running (released, done, never started) has nothing to assess, and an old concern is cleared", async (c) => {
    const h = await c.host("h1");
    const t = await c.work();
    await c.send(h, t, step("start"));
    now += 30 * MIN;
    await c.stall.scan(c.owner);
    assert.equal((await c.stall.list(c.owner)).items.length, 1);
    const a = (await c.assignments.getAssignment(t))!;
    await c.assignments.releaseTask({ commandId: cid("rel"), actor: c.owner.id, taskId: t, expectedRevision: a.revision });
    assert.equal((await c.stall.assess(c.owner, t))!.status, "not_running");
    await c.stall.scan(c.owner);
    const cleared = (await c.stall.list(c.owner, { state: "cleared" })).items;
    assert.deepEqual([cleared.length, cleared[0]!.clearedBecause], [1, "the task has a new owner or is no longer assigned"]);
    // A ready task with an assignment but no attempt is not running either, however long it sits.
    const idle = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.project, title: "idle" })).id;
    await c.projects.transitionTask({ commandId: cid("r"), actor: c.owner.id, taskId: idle, expectedRevision: 1, to: "ready" });
    await c.assignments.assignTask({ commandId: cid("as"), actor: c.owner.id, taskId: idle, owner: { kind: "agent", id: "ann" } });
    now += 5 * 3_600_000;
    assert.equal((await c.stall.assess(c.owner, idle))!.status, "not_running");
    assert.equal((await c.stall.scan(c.owner)).opened, 0);
  });

  suite("a concern is routed to the agent's responsible supervisor, else the owner", async (c) => {
    const h = await c.host("h1");
    const boss = await c.hbAgent("Boss");
    const ann = await c.hbAgent("Ann", { supervisorId: boss.id });
    const loner = await c.hbAgent("Loner");
    const t = await c.work({ owner: ann.id });
    for (let i = 0; i < 6; i++) await c.send(h, t, step("run tests", "tests"));
    const r = await c.stall.scan(c.owner);
    assert.equal(r.opened, 1);
    const concern = (await c.stall.list(c.owner)).items[0]!;
    assert.deepEqual([concern.route.via, concern.route.to], ["supervisor", { kind: "agent", id: boss.id }]);
    assert.match(concern.route.reason, /Boss supervises/);
    // The supervisor sees it (with no grants at all), the agent itself sees it, a stranger does not; unreadable reads like missing.
    assert.equal((await c.stall.list(boss.principal)).items.length, 1);
    assert.equal((await c.stall.get(boss.principal, concern.id))!.id, concern.id);
    assert.equal((await c.stall.get(ann.principal, concern.id))!.id, concern.id);
    assert.equal((await c.stall.list(loner.principal)).items.length, 0);
    assert.equal(await c.stall.get(loner.principal, concern.id), undefined);
    assert.equal(await c.stall.assess(loner.principal, t), undefined);
    assert.equal(await c.stall.assess(loner.principal, "task-aaaaaaaaaaaaaaaaaaaa"), undefined);
    await refuses("not_found", () => c.stall.decide(loner.principal, { commandId: cid("d"), concernId: concern.id, expectedRevision: concern.revision, decision: "dismiss", reason: "x" }));
    // The agent may not dismiss its own concern, even though it can read it.
    await refuses("forbidden", () => c.stall.decide(ann.principal, { commandId: cid("d"), concernId: concern.id, expectedRevision: concern.revision, decision: "dismiss", reason: "I am fine" }));
    // An agent holding assignment.manage still may not decide on a concern about its own task, while another manager may.
    const selfish = await c.plain("selfish", [{ action: "assignment.manage", project: c.project }, { action: "assignment.read", project: c.project }]);
    const mgr = await c.plain("mgr", [{ action: "assignment.manage", project: c.project }]);
    const own = await c.work({ owner: "selfish" });
    for (let i = 0; i < 6; i++) await c.send(h, own, step("run", "run"));
    await c.stall.scan(c.owner);
    const mine = (await c.stall.list(c.owner, { taskId: own })).items[0]!;
    await refuses("forbidden", () => c.stall.decide(selfish, { commandId: cid("d"), concernId: mine.id, expectedRevision: mine.revision, decision: "dismiss", reason: "my own work is fine" }));
    assert.equal((await c.stall.decide(mgr, { commandId: cid("d"), concernId: mine.id, expectedRevision: mine.revision, decision: "confirm", reason: "a manager decided" })).replayed, false);
    await c.stall.decide(c.owner, { commandId: cid("d"), concernId: mine.id, expectedRevision: mine.revision + 1, decision: "confirm", reason: "x" }).then(() => assert.fail("should be refused"), (e: DomainError) => assert.equal(e.code, "invalid_transition"));
    // An agent with no supervisor, and a hand-enrolled agent, route to the owner.
    const t2 = await c.work({ owner: loner.id });
    const t3 = await c.work({ owner: "ann" });
    for (const id of [t2, t3]) for (let i = 0; i < 6; i++) await c.send(h, id, step("run", "run"));
    await c.stall.scan(c.owner);
    const routes = (await c.stall.list(c.owner)).items.filter((i) => i.taskId !== t).map((i) => [i.route.via, i.route.to.kind].join("/"));
    assert.deepEqual(routes, ["owner/owner", "owner/owner"]);
    assert.equal((await c.stall.list(boss.principal)).items.length, 1, "the supervisor sees only what is routed to it");
    // Changing the supervisor moves the concern on the next pass; a retired or missing one falls back to the owner.
    const boss2 = await c.hbAgent("Boss2");
    const rec = (await c.agents.get(c.owner, ann.id))!;
    await c.agents.update(c.owner, { commandId: cid("u"), agentId: ann.id, expectedRevision: rec.revision, supervisorId: boss2.id });
    await c.stall.scan(c.owner);
    const moved = (await c.stall.get(c.owner, concern.id))!;
    assert.deepEqual(moved.route.to, { kind: "agent", id: boss2.id });
    assert.equal((await c.stall.list(boss.principal)).items.length, 0);
    // The new supervisor decides.
    const done = await c.stall.decide(boss2.principal, { commandId: cid("d"), concernId: concern.id, expectedRevision: moved.revision, decision: "confirm", reason: "it is looping on the same failing test" });
    assert.equal(done.replayed, false);
  });

  suite("suspected stalls and confirmed failures are shown apart; decisions are revisioned, repeatable and survive a restart", async (c) => {
    const h = await c.host("h1");
    const t = await c.work();
    for (let i = 0; i < 6; i++) await c.send(h, t, step("run tests", "tests"));
    await c.stall.scan(c.owner);
    const open = (await c.stall.list(c.owner)).items[0]!;
    let view = await c.stall.overview(c.owner);
    assert.deepEqual([view.suspected.length, view.confirmed.length], [1, 0]);
    // Needs the revision and a reason; wrong revision is refused.
    await refuses("stale_revision", () => c.stall.decide(c.owner, { commandId: cid("d"), concernId: open.id, expectedRevision: 99, decision: "confirm", reason: "yes" }), (e) => assert.equal(e.currentRevision, open.revision));
    await assert.rejects(() => c.stall.decide(c.owner, { commandId: cid("d"), concernId: open.id, expectedRevision: open.revision, decision: "confirm", reason: "" }), DomainError);
    await assert.rejects(() => c.stall.decide(c.owner, { commandId: cid("d"), concernId: open.id, expectedRevision: open.revision, decision: "maybe" as never, reason: "x" }), DomainError);
    await refuses("invalid_command", () => c.stall.decide(c.owner, { commandId: cid("d"), concernId: open.id, expectedRevision: open.revision, decision: "confirm", reason: "key ghp_abcdefghijklmnopqrstuvwxyz0123456789" }));
    const id = cid("confirm");
    const first = await c.stall.decide(c.owner, { commandId: id, concernId: open.id, expectedRevision: open.revision, decision: "confirm", reason: "looping on the same failing test" });
    assert.equal((await c.stall.decide(c.owner, { commandId: id, concernId: open.id, expectedRevision: open.revision, decision: "confirm", reason: "looping on the same failing test" })).replayed, true);
    assert.equal(first.revision, open.revision + 1);
    view = await c.stall.overview(c.owner);
    assert.deepEqual([view.suspected.length, view.confirmed.length], [0, 1]);
    assert.deepEqual([view.confirmed[0]!.state, view.confirmed[0]!.decidedBy], ["confirmed", c.owner.id]);
    await refuses("invalid_transition", () => c.stall.decide(c.owner, { commandId: cid("d"), concernId: open.id, expectedRevision: first.revision, decision: "dismiss", reason: "changed my mind" }));
    // A restart (a second service over the same storage) sees the same, and a scan never touches a confirmed concern even when the signals recover.
    const again = c.service();
    assert.equal((await again.get(c.owner, open.id))!.state, "confirmed");
    assert.deepEqual(await again.scan(c.owner), { checked: 1, opened: 0, reopened: 0, cleared: 0, contended: 0 });
    // While the signals are still bad a confirmed concern is left exactly as it is (not reopened, not duplicated).
    await c.send(h, t, step("run tests", "tests"));
    const revBefore = (await again.get(c.owner, open.id))!.revision;
    assert.deepEqual(await again.scan(c.owner), { checked: 1, opened: 0, reopened: 0, cleared: 0, contended: 0 });
    assert.equal((await again.get(c.owner, open.id))!.revision, revBefore);
    await c.send(h, t, { type: "evidence", item: "tests green" });
    assert.deepEqual([(await again.scan(c.owner)).cleared, (await again.get(c.owner, open.id))!.state], [0, "confirmed"], "even when the signals recover");
    // Confirming changed nothing about the task or its assignment.
    assert.equal((await c.assignments.getAssignment(t))!.state, "assigned");
    assert.equal((await c.projects.getTask(t))!.state, "in_progress");
  });

  suite("a dismissed concern stays quiet for a while, then comes back if the signals are still bad; recovery clears and recurrence reopens", async (c) => {
    const h = await c.host("h1");
    const t = await c.work();
    for (let i = 0; i < 6; i++) await c.send(h, t, step("run tests", "tests"));
    await c.stall.scan(c.owner);
    const open = (await c.stall.list(c.owner)).items[0]!;
    await c.stall.decide(c.owner, { commandId: cid("d"), concernId: open.id, expectedRevision: open.revision, decision: "dismiss", reason: "it is a long retry on purpose" });
    assert.equal((await c.stall.list(c.owner, { state: "dismissed" })).items.length, 1);
    await c.send(h, t, step("run tests", "tests"));
    assert.deepEqual(await c.stall.scan(c.owner), { checked: 1, opened: 0, reopened: 0, cleared: 0, contended: 0 });
    now += 7 * 3_600_000;
    await c.send(h, t, step("run tests", "tests"));
    const back = await c.stall.scan(c.owner);
    assert.equal(back.reopened, 1);
    const reopened = (await c.stall.list(c.owner)).items[0]!;
    assert.deepEqual([reopened.id, reopened.reopened, reopened.decision], [open.id, 1, undefined]);
    // Evidence arrives: the loop is answered and the concern clears; the same loop again reopens it.
    await c.send(h, t, { type: "evidence", item: "tests green" });
    assert.equal((await c.stall.scan(c.owner)).cleared, 1);
    assert.equal((await c.stall.get(c.owner, open.id))!.clearedBecause, "the signals recovered");
    for (let i = 0; i < 6; i++) await c.send(h, t, step("run tests", "tests"));
    assert.equal((await c.stall.scan(c.owner)).reopened, 1);
    const twice = (await c.stall.get(c.owner, open.id))!;
    assert.deepEqual([twice.state, twice.reopened], ["suspected", 2]);
    // Scanning again with nothing new writes nothing (same revision) and opens no second record.
    const rev = twice.revision;
    await c.stall.scan(c.owner);

    assert.equal((await c.stall.get(c.owner, open.id))!.revision, rev);
    assert.equal((await c.stall.list(c.owner)).items.length, 1);
  });

  suite("reports: authority, generations, validation, repeats", async (c) => {
    const h = await c.host("h1");
    const t = await c.work();
    const ann = await c.plain("ann", [{ action: "attempt.work", project: c.project }]);
    const bob = await c.plain("bob", [{ action: "attempt.work", project: c.project }]);
    const outsider = await c.host("h2", c.other);
    const reader = await c.plain("reader", [{ action: "assignment.read", project: c.project }]);
    // The owning agent reports for itself; another agent, a host in another project, and a reader may not; the owner may.
    await c.send(ann, t, step("mine"));
    await refuses("forbidden", () => c.send(bob, t, step("not mine")));
    await refuses("forbidden", () => c.send(outsider, t, step("elsewhere")));
    const elsewhereTask = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.other, title: "q" })).id;
    await refuses("forbidden", () => c.send(h, elsewhereTask, step("host without a grant there")));
    await refuses("forbidden", () => c.send(reader, t, step("read only")));
    await c.send(c.owner, t, step("owner"));
    await c.send(h, t, step("host"));
    const missing = await Promise.all([t, "task-aaaaaaaaaaaaaaaaaaaa"].map((id) => c.send(outsider, id, step("x")).then(() => "ok", (e: DomainError) => `${e.code}: ${e.message}`)));
    assert.equal(missing[0], missing[1], "a task the caller cannot work on reads like one that does not exist");
    assert.equal((await c.stall.evidence(c.owner, t))!.steps, 3);
    assert.equal(await c.stall.evidence(bob, t), undefined);
    // A repeat of the same command is recorded once.
    const once = { commandId: "same-report", taskId: t, generation: 1, event: step("dup") };
    await c.stall.report(h, once);
    assert.equal((await c.stall.report(h, once)).replayed, true);
    assert.equal((await c.stall.evidence(c.owner, t))!.steps, 4);
    // Generations: a stale one is fenced; a transfer starts the evidence again for the new owner.
    await refuses("fenced", () => c.send(h, t, step("old"), 2));
    const a = (await c.assignments.getAssignment(t))!;
    await c.assignments.transferTask({ commandId: cid("tr"), actor: c.owner.id, taskId: t, expectedRevision: a.revision, to: { kind: "agent", id: "bob" } });
    await refuses("fenced", () => c.send(h, t, step("old generation"), 1));
    await c.send(h, t, step("new owner's first"), 2);
    const fresh = (await c.stall.evidence(c.owner, t))!;
    assert.deepEqual([fresh.generation, fresh.steps], [2, 1]);
    await refuses("forbidden", () => c.send(ann, t, step("no longer the owner")));
    await c.send(bob, t, step("bob's"), 2);
    // Validation: unknown event types and fields, times sent by the reporter, credential-shaped text, bad numbers, finishing a request that is not open.
    const bad = (event: unknown, code: DomainErrorCode = "invalid_command") => refuses(code, () => c.send(h, t, event as StallEvent, 2));
    await bad({ type: "teleport" });
    await bad({ type: "step", label: "x", at: "2030-01-01T00:00:00.000Z" });
    await bad({ type: "step", label: "" });
    await bad({ type: "step", label: "using ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    await bad({ type: "step", label: "x", actionKey: "k".repeat(121) });
    await bad({ type: "job", status: "dancing" });
    await bad({ type: "spend" });
    await bad({ type: "spend", minutes: -1 });
    await bad({ type: "request_finished", requestId: "none", outcome: "ok" });
    await bad({ type: "request_started", requestId: "r", extra: 1 });
    await bad("step");
    await assert.rejects(() => c.stall.report(h, { commandId: cid("x"), taskId: t, generation: 2, event: step("x"), at: "now" } as never), DomainError);
    await assert.rejects(() => c.stall.report(h, { commandId: cid("x"), taskId: t, generation: 0, event: step("x") }), DomainError);
    // The window is bounded.
    for (let i = 0; i < 40; i++) await c.send(h, t, step(`s${i}`), 2);
    assert.equal((await c.stall.evidence(c.owner, t))!.window.length, 30);
    // A released task has no one to report for.
    const cur = (await c.assignments.getAssignment(t))!;
    await c.assignments.releaseTask({ commandId: cid("rel"), actor: c.owner.id, taskId: t, expectedRevision: cur.revision });
    await refuses("fenced", () => c.send(h, t, step("after release"), 2));
  });

  suite("observed activity counts as the owner's liveness only from the owner or the one reporting, under the current generation", async (c) => {
    const h = await c.host("h1");
    const t = await c.work();
    await c.send(h, t, step("start"));
    now += 25 * MIN;
    assert.deepEqual(await kinds(c, t), ["silent"]);
    const observe = (observedBy: string, generation = 1) => c.assignments.observeActivity({ commandId: cid("obs"), actor: c.owner.id, taskId: t, observedBy, generation, kind: "tests-running" });
    await observe("host:somebody-else");
    assert.deepEqual(await kinds(c, t), ["silent"], "an unrelated reporter's activity is not the owner's");
    await observe("ann", 7);
    assert.deepEqual(await kinds(c, t), ["silent"], "activity under another generation does not count");
    await observe(h.id);
    assert.deepEqual(await kinds(c, t), [], "activity from the host that has been reporting counts");
    now += 25 * MIN;
    assert.deepEqual(await kinds(c, t), ["silent"]);
    await observe("agent:ann");
    assert.deepEqual(await kinds(c, t), [], "and so does the owner's own");
  });

  suite("a scan is for the owner or the recovery service, pages, repeats safely and runs concurrently without duplicates", async (c) => {
    const h = await c.host("h1");
    const ann = await c.plain("ann", [{ action: "attempt.work", project: c.project }]);
    const svc = await c.plain("svc", []);
    await refuses("forbidden", () => c.stall.scan(ann));
    await refuses("forbidden", () => c.stall.scan(h));
    await refuses("forbidden", () => c.stall.scan(svc));
    const tasks: string[] = [];
    for (let i = 0; i < 3; i++) { const t = await c.work(); tasks.push(t); await c.send(h, t, step("start")); }
    now += 30 * MIN;
    const first = await c.stall.scan(c.owner, { limit: 2 });
    assert.deepEqual([first.checked, first.opened, first.next !== undefined], [2, 2, true]);
    const second = await c.stall.scan(c.owner, { limit: 2, afterId: first.next! });
    assert.deepEqual([second.checked, second.opened, second.next], [1, 1, undefined]);
    assert.equal((await c.stall.list(c.owner)).items.length, 3);
    const cap = await c.stall.list(c.owner, { limit: 2 });
    assert.deepEqual([cap.items.length, cap.next !== undefined], [2, true]);
    assert.equal((await c.stall.list(c.owner, { taskId: tasks[0]! })).items.length, 1);
    // Repeating the whole pass changes nothing; two at once leave one concern per task and kind.
    assert.deepEqual(await c.stall.scan(c.owner), { checked: 3, opened: 0, reopened: 0, cleared: 0, contended: 0 });
    const fresh = await c.work();
    await c.send(h, fresh, step("start"));
    now += 30 * MIN;
    const results = await Promise.allSettled([c.stall.scan(c.owner), c.service().scan(c.owner)]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"], JSON.stringify(results));
    assert.equal((await c.stall.list(c.owner, { taskId: fresh })).items.length, 1);
    await assert.rejects(() => c.stall.scan(c.owner, { limit: 0 }), DomainError);
    await assert.rejects(() => c.stall.list(c.owner, { state: "bogus" as never }), DomainError);
  });

  suite("reports sent at the same moment are all accepted and counted once each", async (c) => {
    const h = await c.host("h1");
    const t = await c.work();
    await c.send(h, t, step("first"));
    const results = await Promise.allSettled([1, 2, 3, 4].map((i) => c.send(h, t, step(`s${i}`, `k${i}`))));
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled", "fulfilled"], JSON.stringify(results));
    const e = (await c.stall.evidence(c.owner, t))!;
    assert.deepEqual([e.reports, e.steps], [5, 5]);
  });

  suite("a late report of an earlier generation never overwrites the newer generation's evidence", async (c) => {
    const h = await c.host("h1");
    const t = await c.work();
    await c.send(h, t, step("gen one"));
    const a = (await c.assignments.getAssignment(t))!;
    // Race a transfer, a report for the new generation and a late report for the old one, repeatedly in different orders.
    const results = await Promise.allSettled([
      c.assignments.transferTask({ commandId: cid("tr"), actor: c.owner.id, taskId: t, expectedRevision: a.revision, to: { kind: "agent", id: "bob" } }),
      c.send(h, t, step("late gen one"), 1),
      c.send(h, t, step("gen two"), 2),
    ]);
    assert.equal(results[0]!.status, "fulfilled");
    for (const r of results.slice(1)) if (r.status === "rejected") assert.ok(r.reason instanceof DomainError && r.reason.code === "fenced", String(r.reason));
    await c.send(h, t, step("gen two again"), 2);
    const e = (await c.stall.evidence(c.owner, t))!;
    assert.equal(e.generation, 2);
    assert.ok(!e.window.some((w) => w.key === "late gen one"), "nothing of generation 1 after generation 2 began");
    // And directly: a stored generation 2 refuses a report that still believes in 1 even if it got past the early check.
    await refuses("fenced", () => c.send(h, t, step("too late"), 1));
    // The overtaken case, made deterministic: a service whose early check still sees generation 1 (the assignment moved after it) must be stopped by the check inside the command.
    const overtaken = Object.create(c.assignments) as typeof c.assignments;
    overtaken.getAssignment = async (id: string) => ({ ...(await c.assignments.getAssignment(id))!, generation: 1 });
    const lagging = StallService.withEpoch(c.storage, c.projects.epoch, overtaken, c.waits, { ...options });
    await refuses("fenced", () => lagging.report(h, { commandId: cid("late"), taskId: t, generation: 1, event: step("overtaken") }));
    assert.ok(!(await c.stall.evidence(c.owner, t))!.window.some((w) => w.key === "overtaken"));
  });

  suite("pings are not progress: a hung worker repeating job:running is still silent and stuck", async (c) => {
    const h = await c.host("h1");
    const t = await c.work({ difficulty: "easy" });
    await c.send(h, t, { type: "job", status: "running" });
    await c.send(h, t, { type: "request_started", requestId: "hung" });
    for (let i = 0; i < 12; i++) {
      now += MIN;
      await c.send(h, t, { type: "job", status: "running" });
      await c.send(h, t, { type: "spend", minutes: i });
    }
    // 12 minutes of pings and spend reports: past the easy request (5) and silence (10) limits.
    const a = (await c.stall.assess(c.owner, t))!;
    assert.deepEqual(a.concerns.map((x) => x.kind), ["silent", "stuck_request"]);
    assert.equal(a.status, "suspected");
    // A real step is progress and answers both.
    await c.send(h, t, step("finally did something", "k"));
    assert.deepEqual(await kinds(c, t), []);
    assert.equal((await c.stall.assess(c.owner, t))!.status, "long_running");
    // A change of job status is progress too.
    now += 11 * MIN;
    assert.deepEqual(await kinds(c, t), ["silent"]);
    await c.send(h, t, { type: "job", status: "waiting" });
    assert.deepEqual(await kinds(c, t), []);
  });

  suite("a scan does not invalidate a listed revision: time passing changes no stored concern", async (c) => {
    const h = await c.host("h1");
    const t = await c.work();
    await c.send(h, t, step("start"));
    now += 30 * MIN;
    await c.stall.scan(c.owner);
    const listed = (await c.stall.list(c.owner)).items[0]!;
    for (let i = 0; i < 3; i++) { now += 10 * MIN; assert.equal((await c.stall.scan(c.owner)).contended, 0); }
    const loop = await c.work();
    for (let i = 0; i < 9; i++) await c.send(h, loop, step("tests", "tests"));
    await c.stall.scan(c.owner);
    for (let i = 0; i < 3; i++) await c.send(h, loop, step("tests", "tests"));
    await c.stall.scan(c.owner);
    assert.equal((await c.stall.get(c.owner, listed.id))!.revision, listed.revision);
    const done = await c.stall.decide(c.owner, { commandId: cid("d"), concernId: listed.id, expectedRevision: listed.revision, decision: "confirm", reason: "the worker is gone" });
    assert.equal(done.replayed, false);
    const stored = (await c.stall.get(c.owner, listed.id))! as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(stored).filter((k) => k === "id" || k === "revision").sort(), ["id", "revision"], "the view has them");
    const raw = (await c.storage.getAggregate({ kind: "stall-concern", id: listed.id }))!.body as Record<string, unknown>;
    assert.ok(!("id" in raw) && !("revision" in raw), "the stored body has neither");
  });

  suite("loop detection is not capped by the display window: multi-action cycles at hard and expert", async (c) => {
    const h = await c.host("h1");
    const cycle = async (t: string, rounds: number, size: number) => { for (let r = 0; r < rounds; r++) for (let k = 0; k < size; k++) await c.send(h, t, step(`action ${k}`, `a${k}`)); };
    const hard = await c.work({ difficulty: "hard" });
    await cycle(hard, 7, 4);
    assert.deepEqual(await kinds(c, hard), [], "7 rounds of 4 actions is under the hard threshold of 8");
    await cycle(hard, 1, 4);
    assert.deepEqual(await kinds(c, hard), ["loop"]);
    const expert = await c.work({ difficulty: "expert" });
    await cycle(expert, 9, 4);
    assert.deepEqual(await kinds(c, expert), []);
    await cycle(expert, 1, 4);
    assert.deepEqual(await kinds(c, expert), ["loop"], "10 rounds of 4 actions is 40 steps, beyond the 30-entry display window");
    assert.equal((await c.stall.evidence(c.owner, expert))!.window.length, 30);
    // The map of counts is bounded; a flood of distinct keys cannot grow it.
    const many = await c.work();
    for (let i = 0; i < 80; i++) await c.send(h, many, step(`s${i}`, `key${i}`));
    assert.ok(Object.keys((await c.stall.evidence(c.owner, many))!.counts).length <= 60);
  });

  suite("a confirmed concern is archived when its task is done or its generation changes, and not before", async (c) => {
    const h = await c.host("h1");
    const t = await c.work();
    for (let i = 0; i < 6; i++) await c.send(h, t, step("x", "x"));
    await c.stall.scan(c.owner);
    const open = (await c.stall.list(c.owner)).items[0]!;
    await c.stall.decide(c.owner, { commandId: cid("d"), concernId: open.id, expectedRevision: open.revision, decision: "confirm", reason: "stuck" });
    await c.stall.scan(c.owner);
    assert.equal((await c.stall.get(c.owner, open.id))!.state, "confirmed");
    const a = (await c.assignments.getAssignment(t))!;
    await c.assignments.transferTask({ commandId: cid("tr"), actor: c.owner.id, taskId: t, expectedRevision: a.revision, to: { kind: "agent", id: "bob" } });
    assert.equal((await c.stall.scan(c.owner)).cleared, 1);
    const archived = (await c.stall.get(c.owner, open.id))!;
    assert.deepEqual([archived.state, archived.clearedBecause, archived.decidedBy], ["cleared", "archived: the task has a new owner", c.owner.id]);
    // Done task.
    const t2 = await c.work();
    for (let i = 0; i < 6; i++) await c.send(h, t2, step("x", "x"));
    await c.stall.scan(c.owner);
    const open2 = (await c.stall.list(c.owner, { taskId: t2 })).items[0]!;
    await c.stall.decide(c.owner, { commandId: cid("d"), concernId: open2.id, expectedRevision: open2.revision, decision: "confirm", reason: "stuck" });
    const task = (await c.projects.getTask(t2))!;
    await c.projects.transitionTask({ commandId: cid("done"), actor: c.owner.id, taskId: t2, expectedRevision: task.revision, to: "done" });
    await c.stall.scan(c.owner);
    assert.equal((await c.stall.get(c.owner, open2.id))!.clearedBecause, "archived: the task is done");
  });

  test("assessStall is a pure function of its inputs", () => {
    const base = { now: T0 + 60 * MIN, running: true, waiting: false, difficulty: "medium" as const, thresholds: DEFAULT_THRESHOLDS.medium, attemptStart: T0, budget: {}, requiredEvidence: 0 };
    const a = assessStall(base);
    assert.deepEqual([a.status, a.concerns.map((x) => x.kind), a.signals.silenceMs], ["suspected", ["silent"], 60 * MIN]);
    assert.deepEqual(assessStall(base), a);
    assert.equal(assessStall({ ...base, running: false }).status, "not_running");
    assert.equal(assessStall({ ...base, waiting: true }).status, "waiting");
    assert.equal(assessStall({ ...base, now: T0 + MIN }).status, "healthy");
  });
}
