import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ActivityService } from "../activity/index.js";
import { CatalogService } from "../catalog/index.js";
import { DeskService } from "../context/index.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { EnvironmentService } from "../environments/index.js";
import { ExperimentService } from "../experiments/index.js";
import { NotificationService } from "../notifications/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { StatusService } from "../status/index.js";
import type { ControllerStorage, OperationInput } from "../storage/types.js";
import { AdoptionService, LOOK_LIMITS, noticeText, tellText, type AdoptionLookPorts, type LookBody } from "./index.js";

// Card B05, affected-work slice: when an adoption in force is withdrawn (by a decision or a regression), the same write starts a look at the work that used it. The look reads the catalog's run records
// of the project in bounded pages, tells each unfinished task that ran exactly the withdrawn version (one step in its activity; it keeps the version), leaves finished ones as they are, and then tells the
// owner once. A practice's use is not recorded, so its look tells nobody and says so. A look cut short is carried on by the tick. Real storage on each backend; a fresh service at every step (as after a
// restart); the only clock is the test's.

after(stopServer);

const now = Date.parse("2026-11-27T10:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const hex = (c: string): string => c.repeat(64);
const PROPOSAL = { problem: "reviews send back handlers without error tests", affectedWork: "request handler reviews", change: "add a checklist to the coder prompt", effort: "one afternoon", runningCost: "no extra tokens", benefit: "less rework", evaluation: "the same five handler tasks", stoppingCondition: "two runs" };
const CRITERIA = {
  baseline: { label: "prompt v4", ref: "commit abc123", digest: hex("a") }, evaluator: { label: "review rubric", ref: "rubric 2", digest: hex("b") },
  cases: [{ id: "c1", text: "handler with a missing field" }], baselinePassing: ["c1"],
  baselineMetrics: { timeToAcceptedSeconds: 100, reworkCount: 4 }, budget: { maxRuns: 3, maxCost: 30 }, minRuns: 2, minImprovementPct: 5, maxRegressionPct: 0,
};
const GOOD = { timeToAcceptedSeconds: 80, reworkCount: 3 };
const WORSE = { timeToAcceptedSeconds: 120, reworkCount: 3 };
const GUARD = `sha256:${hex("9")}`;
const MANIFEST = { base: { name: "nimblenewt-base", version: "1.0.0", digest: `sha256:${hex("1")}` }, packages: [], skills: [], capabilities: ["desk.read"], configuration: { installation: 1 }, limits: { cpus: 1, memoryMb: 512, diskMb: 1024, processes: 64 }, protectedExtensions: [{ name: "nimblenewt.guard", digest: GUARD }] };
const SKILL = { purpose: "fetch a page", input: { type: "object" }, output: { type: "object" }, os: ["linux", "darwin"], arch: ["x64", "arm64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 256, seconds: 60 }, cancellation: "cooperative", recovery: "restart" };
const PRACTICE = { kind: "practice" };
const tool = (name: string, version = "1.0.0") => ({ kind: "tool", name, version });
const SERVICE = { id: "service:adoption-looks", kind: "service", name: "adoption-looks", grants: [] } as unknown as Principal;

interface Run { taskId: string; name?: string; version?: string; digest?: string; projectId?: string }
interface Ports { told: string[]; notices: { commandId: string; detail: string; adoptionId: string; projectId: string }[]; paused: Set<string>; ports: (over?: Partial<AdoptionLookPorts>) => AdoptionLookPorts }
interface Ctx {
  owner: Principal; mgr: Principal; dev: Principal; reader: Principal; eve: Principal; maint: Principal; hist: Principal;
  a: string; b: string; storage: ControllerStorage; epoch: number; cat: CatalogService; exps: ExperimentService; projects: ProjectService; activity: ActivityService; p: Ports;
  make(o?: { looks?: AdoptionLookPorts | undefined; storage?: ControllerStorage }): AdoptionService;
  experiment(): Promise<string>;
  ask(experimentId: string, target?: Record<string, unknown>, by?: Principal): Promise<string>;
  rev(id: string): Promise<number>;
  approve(id: string, by?: Principal, svc?: AdoptionService): Promise<{ revision: number }>;
  register(name: string, version: string): Promise<string>;
  task(state?: "proposed" | "done" | "cancelled", project?: string): Promise<string>;
  runs(runs: readonly Run[], projectId?: string): Promise<void>;
  op(operationId: string, over: Partial<OperationInput>): OperationInput;
  steps(taskId: string): Promise<string[]>;
  view(adoptions: unknown, by?: Principal): Promise<string[]>;
}

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const enroll = async (nm: string, grants: Grant[]): Promise<Principal> => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: owner.id, name: "B" })).id;
        const reserved = new Map<string, string>([["nimblenewt.guard", GUARD]]);
        const env = EnvironmentService.withEpoch(world.storage, epoch, { ...options, reservedDigest: async (nm) => reserved.get(nm), skillUsable: async () => true });
        const exps = ExperimentService.withEpoch(world.storage, epoch, { ...options, environments: env });
        const desks = DeskService.withEpoch(world.storage, epoch, options);
        const cat = CatalogService.withEpoch(world.storage, epoch, desks, options);
        const activity = ActivityService.withEpoch(world.storage, epoch, options);
        const told: string[] = []; const notices: Ports["notices"] = []; const paused = new Set<string>();
        const p: Ports = {
          told, notices, paused,
          ports: (over = {}) => ({
            usage: (projectId, afterId, limit) => cat.usage(owner, { projectId, limit, ...(afterId === undefined ? {} : { after: afterId }) }),
            paused: async (t) => paused.has(t),
            tell: async (taskId, commandId, summary, adoptionId) => { told.push(taskId); await activity.record(SERVICE, { commandId, taskId, kind: "lifecycle", summary, manifest: { refs: [{ kind: "adoption", id: adoptionId }] }, outcome: "confirmed" }); },
            notify: async (x) => { notices.push({ ...x }); },
            ...over,
          }),
        };
        const make = (o: { looks?: AdoptionLookPorts | undefined; storage?: ControllerStorage } = {}) => AdoptionService.withEpoch(o.storage ?? world.storage, epoch, { ...options, tools: cat, ...("looks" in o ? (o.looks === undefined ? {} : { looks: o.looks }) : { looks: p.ports() }) });
        const mgr = await enroll("mgr", [{ action: "meeting.manage", project: a }]);
        const dev = await enroll("dev", [{ action: "meeting.agenda", project: a }]);
        const reader = await enroll("reader", [{ action: "meeting.read", project: a }]);
        const hist = await enroll("hist", [{ action: "meeting.read", project: a }, { action: "history.read", project: a }]);
        const eve = await enroll("eve", [{ action: "meeting.manage", project: b }, { action: "meeting.read", project: b }, { action: "catalog.read", project: "*" }]);
        const maint = await enroll("maint", [{ action: "meeting.manage", project: a }, { action: "toolbox.manage", project: "*" }, { action: "catalog.read", project: "*" }]);
        const author = await enroll("author", [{ action: "desk.write", project: a }, { action: "desk.read", project: a }]);
        await env.change(owner, { commandId: cid("env"), agentId: dev.id, manifest: MANIFEST, reason: "first" });
        const note = (await desks.write(author, { commandId: cid("w"), projectId: a, kind: "note", title: "fetch", body: "Use fetch to read a page.", visibility: "shared", status: "accepted" } as never)).id;
        const op = (operationId: string, over: Partial<OperationInput>): OperationInput => ({ operationId, epoch, actor: owner.id, correlationId: `c-${operationId}`, at: new Date(now).toISOString(), changes: [], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [], ...over });
        const ctx: Ctx = {
          owner, mgr, dev, reader, eve, maint, hist, a, b, storage: world.storage, epoch, cat, exps, projects, activity, p, make, op,
          register: async (nm, v) => { await cat.register(owner, { commandId: cid("r"), name: nm, kind: "skill", version: v, manifest: SKILL, instructionsRecordId: note } as never); return (await cat.get(owner, nm, v))!.digest; },
          experiment: async () => {
            const id = (await exps.propose(dev, { commandId: cid("x"), projectId: a, title: "Checklist prompt", proposal: PROPOSAL, affectedKey: `reviews ${n}` } as never)).id;
            await exps.pin(mgr, { commandId: cid("p"), experimentId: id, expectedRevision: (await exps.get(owner, id))!.revision, criteria: CRITERIA } as never);
            for (let i = 0; i < 2; i++) await exps.recordRun(dev, { commandId: cid("r"), experimentId: id, environment: { agentId: dev.id, revision: 1, observed: { "nimblenewt.guard": GUARD }, disposable: true }, cost: 1, metrics: GOOD, cases: [{ id: "c1", passed: true }] } as never);
            await exps.conclude(mgr, { commandId: cid("c"), experimentId: id, expectedRevision: (await exps.get(owner, id))!.revision, finding: "read the runs" });
            return id;
          },
          ask: async (experimentId, target = PRACTICE, by = dev) => (await make().request(by, { commandId: cid("q"), experimentId, target, reason: "it helped" })).id,
          rev: async (id) => (await make().get(owner, id))!.revision,
          approve: async (id, by = maint, svc = make()) => svc.approve(by, { commandId: cid("ap"), adoptionId: id, expectedRevision: await ctx.rev(id), review: "the runs and the baseline agree" }),
          task: async (state = "proposed", project = a) => {
            const id = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: `T${n}` })).id;
            const path = state === "done" ? ["ready", "in_progress", "done"] as const : state === "cancelled" ? ["cancelled"] as const : [];
            for (const to of path) await projects.transitionTask({ commandId: cid("tt"), actor: owner.id, taskId: id, expectedRevision: (await projects.getTask(id))!.revision, to });
            return id;
          },
          // Run records as the catalog's `authorizeRun` writes them (one per run, per project), written straight to storage: the skills used here cannot run, and the look only reads these records.
          runs: async (runs, projectId = a) => {
            const name = "toolbox.fetch"; const version = "1.0.0";
            const digest = (await cat.get(owner, name, version))?.digest ?? `sha256:${hex("0")}`;
            for (let i = 0; i < runs.length; i += 100) await world.storage.applyOperation(op(cid("use"), { changes: runs.slice(i, i + 100).map((r) => ({ type: "create", ref: { kind: `catalog-usage-${projectId}`, id: derivedId("use", cid("u")) }, body: { versionId: "cav-aaaaaaaaaaaaaaaaaaaa", name: r.name ?? name, version: r.version ?? version, digest: r.digest ?? digest, usedBy: dev.id, taskId: r.taskId, projectId: r.projectId ?? projectId, at: new Date(now).toISOString() } as never })) }));
          },
          steps: async (taskId) => (await activity.steps(owner, taskId)).steps.map((s) => (s as { summary?: string }).summary ?? ""),
          view: async (adoptions, by = owner) => (await StatusService.withEpoch(world.storage, epoch, { assignments: {} as never, waits: {} as never, blockers: {} as never, contracts: {} as never, experiments: exps, adoptions: adoptions as never }, options).ask(by, { kind: "experiments", projectId: a }))!.lines.map((l) => l.text),
        };
        await body(ctx);
      } finally { await world.close(); }
    });

  suite("a tool adoption withdrawn by a decision: the same write starts the look; the unfinished tasks that ran exactly that version are told once and keep it, finished ones are left as they are, and the owner is told once", async (c) => {
    await c.register("toolbox.fetch", "1.0.0");
    await c.register("toolbox.fetch", "1.1.0");
    const tPaused = await c.task(); const tOpen = await c.task(); const tDone = await c.task("done"); const tGone = await c.task("cancelled"); const tOther = await c.task();
    const tElse = await c.task("proposed", c.b);
    c.p.paused.add(tPaused);
    const missing = "task-aaaaaaaaaaaaaaaaaaaa";
    await c.runs([{ taskId: tPaused }, { taskId: tPaused }, { taskId: tOpen }, { taskId: tDone }, { taskId: tGone }, { taskId: missing }, { taskId: tOther, version: "1.1.0" }, { taskId: tOther, digest: `sha256:${hex("e")}` }, { taskId: tOther, name: "toolbox.grab" }, { taskId: tElse, projectId: c.b }]);
    // A run record in A's list that names a task of project B (a damaged or forged record): the task is not A's, so it is counted as missing and never told.
    const tForeign = await c.task("proposed", c.b);
    await c.runs([{ taskId: tForeign }]);
    // A run recorded in project B, of the same version, is B's: the look of an adoption in A never reads it.
    await c.runs([{ taskId: tElse }], c.b);
    const exp = await c.experiment();
    const t1 = await c.ask(exp, tool("toolbox.fetch"));
    await c.approve(t1);
    const doneBefore = JSON.stringify(await c.projects.getTask(tDone)); const goneBefore = JSON.stringify(await c.projects.getTask(tGone));
    // Every operation the withdrawal writes is captured: one write, with the look started in it; no effect, timer or outbox entry.
    const seen: OperationInput[] = [];
    const spy = new Proxy(c.storage, { get(t, p, r) { const v = Reflect.get(t, p, r) as unknown; if (p === "applyOperation") return async (input: OperationInput) => { seen.push(input); return t.applyOperation(input); }; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } });
    await c.make({ storage: spy, looks: undefined }).withdraw(c.mgr, { commandId: cid("w"), adoptionId: t1, expectedRevision: await c.rev(t1), reason: "we stop using it" });
    assert.equal(seen.length, 1, "one write");
    assert.deepEqual([...new Set(seen[0]!.changes.map((ch) => ch.ref.kind))].sort(), ["adoption", "adoption-index", "adoption-look", "adoption-looks"]);
    assert.deepEqual([seen[0]!.effects, seen[0]!.settleEffects, seen[0]!.timers, seen[0]!.cancelTimers, seen[0]!.outbox], [[], [], [], [], []]);
    const started = await c.make().affected(c.owner, t1);
    assert.deepEqual([started?.state, started?.scope, started?.why, started?.pages, started?.runs, started?.told], ["looking", "tool-runs", "decision", 0, 0, 0], "recorded, not yet carried on (no ports here)");
    // A fresh service with the ports carries it on (the tick's sweep, or the next look).
    const svc = c.make();
    assert.deepEqual(await svc.sweepAffected(), { looked: 1, failed: 0 });
    const look = (await svc.affected(c.owner, t1))!;
    assert.equal(look.state, "done");
    assert.deepEqual(look.tasks, { [tPaused]: "paused", [tOpen]: "open", [tDone]: "finished", [tGone]: "finished", [missing]: "missing", [tForeign]: "missing" });
    assert.deepEqual([look.runs - 1, look.told, look.untracked, look.partial, look.notified, look.after], [6, 2, 0, undefined, true, undefined]);
    assert.deepEqual(c.p.told.sort(), [tOpen, tPaused].sort(), "only the unfinished tasks are told, each once");
    assert.equal(c.p.notices.length, 1);
    assert.equal(c.p.notices[0]!.commandId, `adoption-look-${t1}`);
    assert.equal(c.p.notices[0]!.projectId, c.a);
    assert.ok(c.p.notices[0]!.detail.length <= 200, c.p.notices[0]!.detail);
    assert.match(c.p.notices[0]!.detail, /6 task\(s\) ran it: 1 paused, 1 open \(told\), 4 finished\./);
    assert.ok(c.p.notices[0]!.detail.indexOf(tPaused) >= 0 && c.p.notices[0]!.detail.indexOf(tPaused) < c.p.notices[0]!.detail.indexOf(tOpen), "a few task IDs, paused first");
    const [stepPaused] = await c.steps(tPaused);
    assert.match(stepPaused!, new RegExp(`Adoption ${t1} of tool toolbox\\.fetch 1\\.0\\.0 in this project was withdrawn \\(by a decision\\).*ran that version and is paused; it keeps it`));
    assert.equal((await c.steps(tOpen)).length, 1);
    // The open task is not told it is paused (second review).
    assert.equal((await c.steps(tOpen))[0], tellText(look, "open"));
    assert.doesNotMatch((await c.steps(tOpen))[0]!, /is paused/);
    assert.deepEqual([(await c.steps(tDone)).length, (await c.steps(tGone)).length, (await c.steps(tOther)).length, (await c.steps(tElse)).length, (await c.steps(tForeign)).length], [0, 0, 0, 0, 0]);
    assert.equal(JSON.stringify(await c.projects.getTask(tDone)), doneBefore, "a finished task is left exactly as it was");
    assert.equal(JSON.stringify(await c.projects.getTask(tGone)), goneBefore);
    assert.equal(await c.make().inForce(c.owner, { projectId: c.a, target: tool("toolbox.fetch") }), undefined);
    // Done and told: a repeat of the withdrawal, another look and further sweeps tell nobody again and write nothing.
    seen.length = 0;
    const quiet = c.make({ storage: spy });
    await quiet.withdraw(c.mgr, { commandId: "w-again", adoptionId: t1, expectedRevision: 2, reason: "we stop using it" }).catch((e: unknown) => assert.ok(e instanceof DomainError));
    assert.equal((await quiet.lookAtAffected(t1))?.notified, true);
    assert.deepEqual(await quiet.sweepAffected(), { looked: 0, failed: 0 }, "nothing is pending");
    assert.equal(seen.filter((s) => s.changes.length > 0).length, 0, "nothing written");
    assert.deepEqual([c.p.told.length, c.p.notices.length], [2, 1]);
  });

  suite("a look cut short is carried on after a restart, page by page, by the tick; the owner's notice failing keeps it pending until it is told; a sweep with nothing pending writes nothing", async (c) => {
    await c.register("toolbox.fetch", "1.0.0");
    const tasks: string[] = [];
    for (let i = 0; i < 6; i++) tasks.push(await c.task());
    // More runs than one call reads (pages of LOOK_LIMITS.page, LOOK_LIMITS.pagesPerCall per call): the later tasks are in the last pages.
    const filler = Array.from({ length: LOOK_LIMITS.page * LOOK_LIMITS.pagesPerCall }, () => ({ taskId: tasks[0]! }));
    await c.runs([...filler, ...tasks.slice(1).map((taskId) => ({ taskId }))]);
    const exp = await c.experiment();
    const t1 = await c.ask(exp, tool("toolbox.fetch"));
    await c.approve(t1);
    // The run records cannot be read at the withdrawal: it is written all the same, and the look waits.
    let reads = 0;
    const broken = c.p.ports({ usage: async () => { reads++; throw new Error("the store is busy"); } });
    await c.make({ looks: broken }).withdraw(c.owner, { commandId: cid("w"), adoptionId: t1, expectedRevision: await c.rev(t1), reason: "stop" });
    assert.equal(reads, 1);
    assert.equal((await c.make().get(c.owner, t1))?.status, "withdrawn", "the withdrawal stands");
    assert.equal((await c.make().affected(c.owner, t1))?.state, "looking");
    assert.deepEqual(await c.make({ looks: broken }).sweepAffected(), { looked: 0, failed: 1 });
    // One call reads at most LOOK_LIMITS.pagesPerCall pages and keeps where it stopped.
    const first = await c.make().lookAtAffected(t1);
    // (Run records are read in record-ID order, not the order they were written, so which tasks are found first is not fixed.)
    assert.deepEqual([first?.state, first?.pages, first?.runs], ["looking", LOOK_LIMITS.pagesPerCall, LOOK_LIMITS.page * LOOK_LIMITS.pagesPerCall]);
    assert.ok(first?.after !== undefined);
    // The status view says it is still looking.
    const text = async () => (await c.view(c.make())).join("\n");
    assert.match(await text(), /The look at the work that ran this version is not finished yet \(200 run\(s\) and [1-6] task\(s\) found so far; it goes on at the next tick\)\./);
    // The owner's notice cannot be sent: the look is done but stays pending, and the view says the owner is not told yet.
    const noNotice = c.p.ports({ notify: async () => { throw new DomainError("unavailable", "the inbox is full"); } });
    assert.deepEqual(await c.make({ looks: noNotice }).sweepAffected(), { looked: 0, failed: 1 });
    const done = (await c.make().affected(c.owner, t1))!;
    assert.deepEqual([done.state, done.notified, done.runs, Object.keys(done.tasks).length, done.told], ["done", undefined, LOOK_LIMITS.page * LOOK_LIMITS.pagesPerCall + 5, 6, 6]);
    // Done after several pages: the cursor is gone, the time it finished is kept, and the answer carries the look's own revision (second review).
    assert.deepEqual([done.after, done.doneAt, done.revision], [undefined, new Date(now).toISOString(), (await c.storage.getAggregate({ kind: "adoption-look", id: t1 }))!.revision]);
    assert.match(await text(), /6 task\(s\) ran this version; 0 paused and 6 open were told in their activity and keep the version, 0 finished or gone were left as they are\. The owner has not been told yet\./);
    // The next tick tells the owner and takes it out of the pending list; each task was told exactly once in all.
    assert.deepEqual(await c.make().sweepAffected(), { looked: 1, failed: 0 });
    assert.equal(c.p.notices.length, 1);
    assert.equal((await c.make().affected(c.owner, t1))?.notified, true);
    for (const t of tasks) assert.equal((await c.steps(t)).length, 1, t);
    assert.doesNotMatch(await text(), /not been told/);
    const seen: OperationInput[] = [];
    const spy = new Proxy(c.storage, { get(t, p, r) { const v = Reflect.get(t, p, r) as unknown; if (p === "applyOperation") return async (input: OperationInput) => { seen.push(input); return t.applyOperation(input); }; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } });
    for (let i = 0; i < 3; i++) assert.deepEqual(await c.make({ storage: spy }).sweepAffected(), { looked: 0, failed: 0 });
    assert.equal(seen.length, 0, "an idle tick writes nothing");
  });

  suite("a task told while it was paused, whose look write was then lost, is not told again when it is open at the retry, and the look finishes (first review)", async (c) => {
    await c.register("toolbox.fetch", "1.0.0");
    const t = await c.task();
    await c.runs([{ taskId: t }]);
    const exp = await c.experiment();
    const t1 = await c.ask(exp, tool("toolbox.fetch"), c.reader);
    await c.approve(t1);
    // Withdrawn where nothing carries the look on: it is recorded and waits.
    await c.make({ looks: undefined }).withdraw(c.owner, { commandId: cid("w"), adoptionId: t1, expectedRevision: await c.rev(t1), reason: "stop" });
    const waiting = (await c.make().affected(c.owner, t1))!;
    assert.equal(waiting.state, "looking");
    // An earlier step told the task while it was paused, then its look write was lost: the step is there under the adoption's and the task's command ID, with the paused words.
    await c.activity.record(SERVICE, { commandId: `adp-look-${t1}-${t}`, taskId: t, kind: "lifecycle", summary: tellText(waiting as LookBody, "paused"), manifest: { refs: [{ kind: "adoption", id: t1 }] }, outcome: "confirmed" });
    // Now the task is open: the same command ID with other words is refused as a conflict, which means it was told. The look goes on and finishes; the task has its one step.
    assert.deepEqual(await c.make().sweepAffected(), { looked: 1, failed: 0 });
    const look = (await c.make().affected(c.owner, t1))!;
    assert.deepEqual([look.state, look.notified, look.tasks, look.told], ["done", true, { [t]: "open" }, 1]);
    assert.deepEqual(await c.steps(t), [tellText(waiting as LookBody, "paused")]);
    assert.equal(c.p.notices.length, 1);
    // A tell that fails for another reason is not taken as told: the look waits for the next tick.
    const t2 = await c.task();
    await c.runs([{ taskId: t2 }]);
    const exp2 = await c.experiment();
    const a2 = await c.ask(exp2, tool("toolbox.fetch"), c.reader);
    await c.approve(a2);
    const failing = c.p.ports({ tell: async () => { throw new DomainError("unavailable", "the store is busy"); } });
    await c.make({ looks: failing }).withdraw(c.owner, { commandId: cid("w"), adoptionId: a2, expectedRevision: await c.rev(a2), reason: "stop" });
    assert.equal((await c.make().affected(c.owner, a2))?.state, "looking");
    assert.equal((await c.make().affected(c.owner, a2))?.told, 0);
  });

  suite("the owner was told, the look's told write was lost and the notice was closed meanwhile: the retry does not tell the owner again, and the look finishes (second review)", async (c) => {
    await c.register("toolbox.fetch", "1.0.0");
    const t = await c.task();
    await c.runs([{ taskId: t }]);
    const exp = await c.experiment();
    const t1 = await c.ask(exp, tool("toolbox.fetch"), c.reader);
    await c.approve(t1);
    const ntf = NotificationService.withEpoch(c.storage, c.epoch, options);
    const looks = c.p.ports({ notify: async (x) => { await ntf.emitFromController({ commandId: x.commandId, kind: "maintenance", level: "notice", ref: { kind: "adoption", id: x.adoptionId }, projectId: x.projectId, detail: x.detail }); } });
    await c.make({ looks: undefined }).withdraw(c.owner, { commandId: cid("w"), adoptionId: t1, expectedRevision: await c.rev(t1), reason: "stop" });
    // An earlier finish gave the owner the notice under the look's command ID, then its told write was lost; the owner's notice was closed (it expired, or was settled) before the retry.
    await looks.notify({ commandId: `adoption-look-${t1}`, adoptionId: t1, projectId: c.a, detail: "earlier words" });
    assert.equal((await ntf.settleFromController({ commandId: cid("settle"), kind: "maintenance", ref: { kind: "adoption", id: t1 }, projectId: c.a })).closed, true);
    const items = async () => (await c.storage.listAggregates("notification-item", { limit: 500 })).filter((a) => (a.body as { ref?: { id?: string } }).ref?.id === t1);
    assert.equal((await items()).length, 1);
    // The retry's notice lands on a new occurrence, so the same command ID is a conflict: that means the owner was told. The look is marked told and leaves the pending list; no second notice.
    assert.deepEqual(await c.make({ looks }).sweepAffected(), { looked: 1, failed: 0 });
    const look = (await c.make().affected(c.owner, t1))!;
    assert.deepEqual([look.state, look.notified, look.told], ["done", true, 1]);
    assert.equal((await items()).length, 1, "the owner is not told twice");
    assert.deepEqual(((await c.storage.getAggregate({ kind: "adoption-looks", id: "installation" }))!.body as { pending: string[] }).pending, []);
    // The look written again while the owner was being told (another process, a restore): the told write meets a newer revision; that is contained, and the next call tells the owner and finishes.
    const expR = await c.experiment();
    const aR = await c.ask(expR, tool("toolbox.fetch"), c.reader);
    await c.approve(aR);
    let bumped = 0;
    const racing = c.p.ports({ notify: async () => {
      if (bumped++ > 0) return;
      const agg = (await c.storage.getAggregate({ kind: "adoption-look", id: aR }))!;
      await c.storage.applyOperation(c.op(cid("bump"), { changes: [{ type: "update", ref: { kind: "adoption-look", id: aR }, expectedRevision: agg.revision, body: agg.body }] }));
    } });
    await c.make({ looks: undefined }).withdraw(c.owner, { commandId: cid("w"), adoptionId: aR, expectedRevision: await c.rev(aR), reason: "stop" });
    const raced = await c.make({ looks: racing }).lookAtAffected(aR);
    assert.deepEqual([raced?.state, raced?.notified, bumped], ["done", undefined, 1]);
    assert.equal((await c.make({ looks: racing }).lookAtAffected(aR))?.notified, true);
    // A notice that fails for another reason is still not taken as told.
    const exp2 = await c.experiment();
    const a2 = await c.ask(exp2, tool("toolbox.fetch"), c.reader);
    await c.approve(a2);
    await c.make({ looks: c.p.ports({ notify: async () => { throw new DomainError("unavailable", "the store is busy"); } }) }).withdraw(c.owner, { commandId: cid("w"), adoptionId: a2, expectedRevision: await c.rev(a2), reason: "stop" });
    assert.deepEqual([(await c.make().affected(c.owner, a2))?.state, (await c.make().affected(c.owner, a2))?.notified], ["done", undefined]);
  });

  suite("the tick goes round the pending list: a look that keeps failing does not hold up the ones after it (first review)", async (c) => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) { const exp = await c.experiment(); const id = await c.ask(exp); await c.approve(id); ids.push(id); }
    for (const id of ids) await c.make({ looks: undefined }).withdraw(c.owner, { commandId: cid("w"), adoptionId: id, expectedRevision: await c.rev(id), reason: "stop" });
    const [stuck, , , last] = ids as [string, string, string, string];
    // The owner's notice for the first look always fails; the others go through.
    const ports = c.p.ports({ notify: async (x) => { if (x.adoptionId === stuck) throw new DomainError("unavailable", "the inbox is full"); c.p.notices.push({ ...x }); } });
    const svc = c.make({ looks: ports });
    assert.deepEqual(await svc.sweepAffected(), { looked: 1, failed: 1 });
    // The next tick begins where this one stopped, not again at the failing look: the last look is finished by the second tick.
    await svc.sweepAffected();
    assert.equal((await c.make().affected(c.owner, last))?.notified, true);
    assert.equal((await c.make().affected(c.owner, stuck))?.notified, undefined);
  });

  suite("a regression withdraws and starts the look in the same write; a practice's look tells nobody and says why; declining or taking back starts none; without ports the look waits", async (c) => {
    await c.register("toolbox.fetch", "1.0.0");
    const t = await c.task();
    await c.runs([{ taskId: t }]);
    const exp = await c.experiment();
    const p1 = await c.ask(exp, PRACTICE);
    const t1 = await c.ask(exp, tool("toolbox.fetch"));
    const asked = await c.ask(await c.experiment(), PRACTICE);
    const takenBack = await c.ask(await c.experiment(), PRACTICE);
    await c.approve(p1, c.owner);
    await c.approve(t1);
    const r = await c.make().monitor(c.dev, { commandId: cid("m"), adoptionId: t1, metrics: WORSE });
    assert.deepEqual([r.status, r.regressed], ["withdrawn", ["timeToAcceptedSeconds"]]);
    const tl = (await c.make().affected(c.owner, t1))!;
    assert.deepEqual([tl.why, tl.state, tl.tasks, tl.told, tl.notified], ["regression", "done", { [t]: "open" }, 1, true], "the look ran right after the regression");
    assert.match((await c.steps(t))[0]!, /withdrawn \(monitoring showed a regression\)/);
    assert.match(c.p.notices.at(-1)!.detail, /withdrawn \(regression\)\. 1 task\(s\) ran it: 0 paused, 1 open \(told\), 0 finished\. E\.g\. task-/);
    // A practice: nobody is told, and the record and the notice say why.
    await c.make().monitor(c.dev, { commandId: cid("m"), adoptionId: p1, metrics: WORSE });
    const pl = (await c.make().affected(c.owner, p1))!;
    assert.deepEqual([pl.scope, pl.state, pl.tasks, pl.pages, pl.notified], ["not-recorded", "done", {}, 0, true]);
    assert.match(c.p.notices.at(-1)!.detail, /Which tasks applied a practice is not recorded, so no task was told\./);
    assert.equal(c.p.told.length, 1);
    // Declined, or taken back by its asker: never in force, so no look.
    await c.make().decline(c.owner, { commandId: cid("d"), adoptionId: asked, expectedRevision: await c.rev(asked), reason: "not now" });
    await c.make().decline(c.dev, { commandId: cid("d"), adoptionId: takenBack, expectedRevision: await c.rev(takenBack), reason: "mine, not needed" });
    assert.deepEqual([await c.make().affected(c.owner, asked), await c.make().affected(c.owner, takenBack)], [undefined, undefined]);
    assert.equal(c.p.notices.length, 2);
    // The status view says what each look found.
    const lines = await c.view(c.make());
    assert.ok(lines.some((l) => l.includes(t1) && l.includes("Affected work, from the tool's run records: 1 task(s) ran this version; 0 paused and 1 open were told")), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes(p1) && l.includes("Which tasks applied the practice is not recorded, so no task was found or told.")));
    assert.ok(lines.some((l) => l.includes(asked) && !l.includes("Affected work") && !l.includes("not recorded")));
    // With a status service whose adoptions cannot read the look, the line says so and the view still answers.
    const failing = { list: (by: Principal, project: string, page: never) => c.make().list(by, project, page), standing: (by: Principal, id: string) => c.make().standing(by, id), affected: async () => { throw new Error("read failed"); } };
    const flines = await c.view(failing);
    assert.ok(flines.some((l) => l.includes(t1) && l.includes("The look at the work that used it cannot be read right now.")));
    // Without ports the withdrawal still records its look, which waits for a controller that has them.
    const p2 = await c.ask(await c.experiment(), PRACTICE);
    await c.approve(p2, c.owner);
    await c.make({ looks: undefined }).withdraw(c.owner, { commandId: cid("w"), adoptionId: p2, expectedRevision: await c.rev(p2), reason: "stop" });
    assert.equal((await c.make({ looks: undefined }).sweepAffected()).looked, 0);
    assert.equal((await c.make({ looks: undefined }).lookAtAffected(p2)), undefined);
    assert.equal((await c.make().affected(c.owner, p2))?.state, "looking");
    assert.equal((await c.make().sweepAffected()).looked, 1);
    assert.equal((await c.make().affected(c.owner, p2))?.notified, true);
  });

  suite("the look is read only by the adoption's readers, with no difference between unknown and forbidden; hostile run records are skipped", async (c) => {
    await c.register("toolbox.fetch", "1.0.0");
    const t = await c.task();
    await c.runs([{ taskId: t }]);
    // Hostile records in the project's run list: no task ID, a task ID that is not a string, another project's run, a damaged digest.
    await c.storage.applyOperation(c.op(cid("bad"), { changes: [
      { type: "create", ref: { kind: `catalog-usage-${c.a}`, id: derivedId("use", "bad1") }, body: { name: "toolbox.fetch", version: "1.0.0", digest: (await c.cat.get(c.owner, "toolbox.fetch", "1.0.0"))!.digest, projectId: c.a } as never },
      { type: "create", ref: { kind: `catalog-usage-${c.a}`, id: derivedId("use", "bad2") }, body: { name: "toolbox.fetch", version: "1.0.0", digest: (await c.cat.get(c.owner, "toolbox.fetch", "1.0.0"))!.digest, projectId: c.a, taskId: 7 } as never },
      { type: "create", ref: { kind: `catalog-usage-${c.a}`, id: derivedId("use", "bad3") }, body: { name: "toolbox.fetch", version: "1.0.0", digest: null, projectId: c.a, taskId: t } as never },
    ] }));
    const exp = await c.experiment();
    const t1 = await c.ask(exp, tool("toolbox.fetch"), c.reader);
    await c.approve(t1);
    await c.make().withdraw(c.owner, { commandId: cid("w"), adoptionId: t1, expectedRevision: await c.rev(t1), reason: "stop" });
    const look = (await c.make().affected(c.owner, t1))!;
    assert.deepEqual([look.runs, look.tasks, look.told], [1, { [t]: "open" }, 1]);
    for (const by of [c.owner, c.mgr, c.reader]) assert.equal((await c.make().affected(by, t1))?.adoptionId, t1, by.id);
    // First review: the task IDs come from the run records, which need history.read in the project; a reader of the adoption without it gets the counts only. The status view's words are the same for both.
    for (const by of [c.mgr, c.reader]) {
      const seen = (await c.make().affected(by, t1))!;
      assert.deepEqual([seen.tasks, seen.tasksHidden, seen.counts], [{}, true, { paused: 0, open: 1, finished: 0, missing: 0 }], by.id);
    }
    for (const by of [c.owner, c.hist]) {
      const seen = (await c.make().affected(by, t1))!;
      assert.deepEqual([seen.tasks, seen.tasksHidden, seen.counts.open], [{ [t]: "open" }, undefined, 1], by.id);
    }
    // The status view gives a reader without history.read the same counts as the owner.
    for (const by of [c.owner, c.reader]) assert.match((await c.view(c.make(), by)).join("\n"), /Affected work, from the tool's run records: 1 task\(s\) ran this version; 0 paused and 1 open were told/, by.id);
    for (const id of [t1, "adp-aaaaaaaaaaaaaaaaaaaa", "nope", 3 as unknown as string]) assert.equal(await c.make().affected(c.eve, id), undefined, String(id));
    assert.equal(await c.make().affected(c.dev, t1), undefined, "neither a reader of the project nor the asker");
    assert.equal(await c.make().affected(c.owner, "adp-aaaaaaaaaaaaaaaaaaaa"), undefined);
    await assert.rejects(c.make().lookAtAffected("nope"), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
  });

  suite("bounds: at most LOOK_LIMITS.tasks tasks are recorded and LOOK_LIMITS.pages pages read, then the look is done and partial; a full pending list never blocks a withdrawal; two looks at once tell each task once", async (c) => {
    await c.register("toolbox.fetch", "1.0.0");
    const digest = (await c.cat.get(c.owner, "toolbox.fetch", "1.0.0"))!.digest;
    const exp = await c.experiment();
    const t1 = await c.ask(exp, tool("toolbox.fetch"));
    await c.approve(t1);
    // An endless run list (a fake catalog page that always has more): every run names a new task that does not exist.
    let pages = 0;
    const endless = c.p.ports({ usage: async (projectId, afterId, limit) => { pages++; const base = Number(afterId ?? "0"); return { items: Array.from({ length: limit }, (_, i) => ({ versionId: "cav-x", name: "toolbox.fetch", version: "1.0.0", digest, usedBy: "agent:dev", taskId: derivedId("task", `${base + i}`), projectId, at: "2026-11-27T10:00:00.000Z" })), next: String(base + limit) }; } });
    await c.make({ looks: endless }).withdraw(c.owner, { commandId: cid("w"), adoptionId: t1, expectedRevision: await c.rev(t1), reason: "stop" });
    for (let i = 0; i < LOOK_LIMITS.pages && (await c.make().affected(c.owner, t1))?.state === "looking"; i++) await c.make({ looks: endless }).sweepAffected();
    const look = (await c.make().affected(c.owner, t1))!;
    assert.equal(pages, LOOK_LIMITS.pages, "exactly the page limit is read");
    assert.deepEqual([look.state, look.partial, look.pages, Object.keys(look.tasks).length, look.runs, look.untracked, look.told, look.notified], ["done", true, LOOK_LIMITS.pages, LOOK_LIMITS.tasks, LOOK_LIMITS.pages * LOOK_LIMITS.page, LOOK_LIMITS.pages * LOOK_LIMITS.page - LOOK_LIMITS.tasks, 0, true]);
    assert.ok(Object.values(look.tasks).every((s) => s === "missing"));
    assert.match(c.p.notices.at(-1)!.detail, /200 task\(s\) ran it \(more not read\): 0 paused, 0 open \(told\), 200 finished\./);
    // A full pending list: the withdrawal is written anyway; its look is marked unlisted and still runs right after it.
    const list = (await c.storage.getAggregate({ kind: "adoption-looks", id: "installation" }))!;
    assert.deepEqual(list.body, { pending: [] }, "the done look left the list");
    await c.storage.applyOperation(c.op(cid("full"), { changes: [{ type: "update", ref: { kind: "adoption-looks", id: "installation" }, expectedRevision: list.revision, body: { pending: Array.from({ length: LOOK_LIMITS.pending }, (_, i) => derivedId("adp", `ghost${i}`)) } as never }] }));
    const p1 = await c.ask(exp, PRACTICE);
    await c.approve(p1, c.owner);
    await c.make().withdraw(c.owner, { commandId: cid("w"), adoptionId: p1, expectedRevision: await c.rev(p1), reason: "stop" });
    const pl = (await c.make().affected(c.owner, p1))!;
    assert.deepEqual([pl.unlisted, pl.state, pl.notified], [true, "done", true]);
    // The sweep takes the ghosts (no look record) out of the list, a few per tick.
    const listed = async () => ((await c.storage.getAggregate({ kind: "adoption-looks", id: "installation" }))!.body as { pending: string[] }).pending.length;
    await c.make().sweepAffected();
    assert.equal(await listed(), LOOK_LIMITS.pending - LOOK_LIMITS.perTick);
    // Two looks at once (two processes): each task is told once, and the record is consistent.
    const ta = await c.task(); const tb = await c.task();
    c.p.paused.add(tb);
    await c.runs([{ taskId: ta }, { taskId: tb }, { taskId: ta }]);
    const t2 = await c.ask(await c.experiment(), tool("toolbox.fetch"));
    await c.approve(t2);
    await c.make({ looks: undefined }).withdraw(c.owner, { commandId: cid("w"), adoptionId: t2, expectedRevision: await c.rev(t2), reason: "stop" });
    const before = c.p.told.length;
    await Promise.all([c.make().lookAtAffected(t2), c.make().lookAtAffected(t2)]);
    await c.make().lookAtAffected(t2);
    const l2 = (await c.make().affected(c.owner, t2))!;
    assert.deepEqual([l2.state, l2.tasks, l2.runs, l2.notified], ["done", { [ta]: "open", [tb]: "paused" }, 3, true]);
    assert.deepEqual([(await c.steps(ta)).length, (await c.steps(tb)).length], [1, 1], "the activity step of each task is written once");
    assert.ok(c.p.told.length - before >= 2);
    assert.equal(new Set(c.p.notices.filter((x) => x.adoptionId === t2).map((x) => x.commandId)).size, 1, "one notice (a repeat carries the same command ID)");
  });
}

test("the owner's notice stays within the notification detail limit and names a few tasks, paused ones first", () => {
  const base: LookBody = { adoptionId: "adp-aaaaaaaaaaaaaaaaaaaa", projectId: "prj-x", experimentId: "exp-x", target: { kind: "tool", name: "toolbox." + "x".repeat(110), version: "123456789.123456789.123456789-rc.1" }, why: "decision", state: "done", scope: "tool-runs", pages: 1, runs: 9, tasks: {}, untracked: 0, told: 0, startedAt: "t" };
  const ids = Array.from({ length: 9 }, (_, i) => `task-${String(i).repeat(20)}`);
  const tasks = Object.fromEntries(ids.map((id, i) => [id, i < 3 ? "open" : i < 6 ? "finished" : "paused"] as const));
  const text = noticeText({ ...base, tasks });
  assert.ok(text.length <= 200, text);
  assert.match(text, /9 task\(s\) ran it: 3 paused, 3 open \(told\), 3 finished\. E\.g\. task-6+, task-7+, task-8+$/);
  assert.equal(noticeText({ ...base, tasks, partial: true }).includes("(more not read)"), true);
  assert.ok(noticeText({ ...base, adoptionId: "adp-" + "b".repeat(20), why: "regression", tasks: Object.fromEntries(ids.map((id) => [id, "paused"])) }).length <= 200);
  // First review: IDs that do not all fit are left out whole, never cut part-way.
  const long = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`task-${String(i).repeat(40)}`, "paused"] as const));
  const cut = noticeText({ ...base, tasks: long });
  assert.match(cut, /3 task\(s\) ran it: 3 paused, 0 open \(told\), 0 finished\.$/, cut);
});
