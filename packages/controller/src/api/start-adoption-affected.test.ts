import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { derivedId } from "../domain/ids.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { OperationInput } from "../storage/types.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const SKILL = { purpose: "lint a file", input: { type: "object" }, output: { type: "object" }, os: ["linux", "darwin"], arch: ["x64", "arm64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 256, seconds: 60 }, cancellation: "cooperative", recovery: "restart" };

// Card B05, affected-work slice, in the composed controller: the owner withdraws an adopted tool version. The same write starts the look; right after it the controller reads the project's tool run
// records, writes one activity step into each unfinished task that ran the version (a paused one and an open one; it keeps the version), leaves the finished one as it is, and puts one Notice in the
// owner's inbox. `adoption.affected` and the experiments status view say what it found. A look interrupted before it was carried on (simulated by putting the record back as the withdrawal wrote it) is
// finished by the dispatcher's tick after a restart, telling no task and the owner no second time.
test("a withdrawn tool adoption's affected work is found from the run records, the unfinished tasks and the owner are told once, and the tick finishes an interrupted look after a restart (card B05)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-adpa-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }) } });
  let c = await open();
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const made = await s.agents.create(rob, { commandId: "mk-ann", friendlyName: "Ann", roles: ["author"] });
    const ann = { id: `agent:${made.id}`, token: "" };
    await s.grants.grant(rob, { commandId: "g-ann", grantee: ann.id, action: "meeting.agenda", project, source: "direct", basis: "test" } as never);
    await s.grants.grant(rob, { commandId: "g-ann-d", grantee: ann.id, action: "desk.write", project, source: "direct", basis: "test" } as never);
    ann.token = (await s.principals.issueCredential(rob, ann.id)).token;
    const annP = await s.principals.authenticate(ann.token);

    const proposal = { problem: "slow", affectedWork: "reviews", change: "a lint step", effort: "a day", runningCost: "none", benefit: "less rework", evaluation: "five tasks", stoppingCondition: "one run" };
    const id = (await call(ann.token, "experiment.propose", { projectId: project, title: "Lint", proposal, affectedKey: "reviews" }, "e1")).result.id as string;
    const criteria = { baseline: { label: "v4", ref: "abc", digest: "a".repeat(64) }, evaluator: { label: "r", ref: "r2", digest: "b".repeat(64) }, cases: [{ id: "c1", text: "missing field" }], baselinePassing: ["c1"], baselineMetrics: { timeToAcceptedSeconds: 100 }, budget: { maxRuns: 1, maxCost: 10 }, minRuns: 1 };
    assert.ok((await call(boot.token, "experiment.pin", { experimentId: id, expectedRevision: 1, criteria }, "x1")).ok);
    const manifest = { base: { name: "nimblenewt-base", version: "1.0.0", digest: `sha256:${"1".repeat(64)}` }, packages: [], skills: [], capabilities: [], configuration: {}, limits: { cpus: 1, memoryMb: 512, diskMb: 1024, processes: 64 }, protectedExtensions: [] };
    await s.environments.change(rob, { commandId: "env-ann", agentId: ann.id, manifest, reason: "first" });
    assert.ok((await call(ann.token, "experiment.run", { experimentId: id, environment: { agentId: ann.id, revision: 1, observed: {}, disposable: true }, cost: 2, metrics: { timeToAcceptedSeconds: 80 }, cases: [{ id: "c1", passed: true }] }, "run1")).ok);
    const exp = (await call(boot.token, "experiment.get", { experimentId: id })).result.item;
    assert.equal((await call(boot.token, "experiment.conclude", { experimentId: id, expectedRevision: exp.revision, finding: "faster" }, "c1")).result.verdict, "improved");
    const note = (await s.desks.write(annP, { commandId: "n1", projectId: project, kind: "note", title: "lint", body: "Run lint on the file.", visibility: "shared", status: "accepted" } as never)).id;
    await s.catalog.register(rob, { commandId: "reg-1", name: "toolbox.lint", kind: "skill", version: "1.0.0", manifest: SKILL, instructionsRecordId: note } as never);
    const digest = (await s.catalog.get(rob, "toolbox.lint", "1.0.0"))!.digest;
    const target = { kind: "tool", name: "toolbox.lint", version: "1.0.0" };
    const adp = (await call(ann.token, "adoption.request", { experimentId: id, target, reason: "lint helped" }, "a1")).result.id as string;
    assert.ok((await call(boot.token, "adoption.approve", { adoptionId: adp, expectedRevision: 1, review: "the run beat the baseline" }, "ap1")).ok);

    // Three tasks ran that version (as the catalog records runs): one is paused, one open, one done.
    const task = async (title: string) => (await s.projects.createTask({ commandId: `t-${title}`, actor: rob.id, projectId: project, title })).id;
    const tPaused = await task("paused"); const tOpen = await task("open"); const tDone = await task("done");
    for (const to of ["ready", "in_progress", "done"] as const) await s.projects.transitionTask({ commandId: `tt-${to}`, actor: rob.id, taskId: tDone, expectedRevision: (await s.projects.getTask(tDone))!.revision, to });
    await s.pauses.pause(rob, { commandId: "pz", scope: { kind: "task", id: tPaused }, reason: "waiting" });
    const op = (operationId: string, over: Partial<OperationInput>): OperationInput => ({ operationId, epoch: c.epoch, actor: rob.id, correlationId: `c-${operationId}`, at: new Date().toISOString(), changes: [], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [], ...over });
    await c.storage.applyOperation(op("uses", { changes: [tPaused, tOpen, tDone, tOpen].map((taskId, i) => ({ type: "create", ref: { kind: `catalog-usage-${project}`, id: derivedId("use", `u${i}`) }, body: { versionId: "cav-aaaaaaaaaaaaaaaaaaaa", name: "toolbox.lint", version: "1.0.0", digest, usedBy: ann.id, taskId, projectId: project, at: new Date().toISOString() } as never })) }));
    const doneBefore = JSON.stringify(await s.projects.getTask(tDone));

    const rev = (await call(boot.token, "adoption.get", { adoptionId: adp })).result.item.revision as number;
    assert.ok((await call(boot.token, "adoption.withdraw", { adoptionId: adp, expectedRevision: rev, reason: "we stop using it" }, "w1")).ok);
    const affected = async (token = boot.token) => (await call(token, "adoption.affected", { adoptionId: adp })) as { ok: boolean; result?: { item: any }; error?: { code: string } };
    const look = (await affected()).result!.item;
    assert.deepEqual([look.state, look.why, look.runs, look.told, look.notified, look.tasks], ["done", "decision", 4, 2, true, { [tPaused]: "paused", [tOpen]: "open", [tDone]: "finished" }]);
    assert.equal((await affected(ann.token)).result?.item.adoptionId, adp, "the asker reads it");
    assert.equal((await call(boot.token, "adoption.affected", { adoptionId: "adp-aaaaaaaaaaaaaaaaaaaa" })).error.code, "not_found");
    const steps = async (taskId: string) => ((await call(boot.token, "activity.steps", { taskId })).result.steps as { summary: string; kind: string }[]);
    const [paused] = await steps(tPaused);
    assert.equal(paused?.kind, "lifecycle");
    assert.match(paused!.summary, new RegExp(`Adoption ${adp} of tool toolbox\\.lint 1\\.0\\.0 in this project was withdrawn \\(by a decision\\), so it is no longer in force\\. This task ran that version and is paused; it keeps it`));
    assert.equal((await steps(tOpen)).length, 1);
    assert.equal((await steps(tDone)).length, 0, "a finished task is not written to");
    assert.equal(JSON.stringify(await s.projects.getTask(tDone)), doneBefore);
    assert.equal(await s.pauses.isPaused(tPaused), true, "the paused task stays paused");
    const notices = async () => (await c.storage.listAggregates("notification-item", { limit: 500 })).filter((a) => (a.body as { ref?: { kind?: string; id?: string } }).ref?.id === adp).map((a) => a.body as { kind: string; level: string; detail: string; count: number; projectId: string });
    const [notice] = await notices();
    assert.deepEqual([(await notices()).length, notice?.kind, notice?.level, notice?.projectId, notice?.count], [1, "maintenance", "notice", project, 1]);
    assert.match(notice!.detail, new RegExp(`Adoption ${adp} withdrawn \\(decision\\)\\. 3 task\\(s\\) ran it: 1 paused, 1 open \\(told\\), 1 finished\\. E\\.g\\. ${tPaused}, ${tOpen}`));
    const text = async () => ((await call(boot.token, "status.ask", { request: { kind: "experiments", projectId: project } })).result.item.lines as { text: string }[]).map((l) => l.text).join("\n");
    assert.match(await text(), /withdrawn by owner:rob, no longer used\. No monitoring report yet\. Affected work, from the tool's run records: 3 task\(s\) ran this version; 1 paused and 1 open were told in their activity and keep the version, 1 finished or gone were left as they are\./);

    // An interrupted look: put the look back as the withdrawal wrote it (nothing read, nobody told, listed as pending), then restart.
    const lookAgg = (await c.storage.getAggregate({ kind: "adoption-look", id: adp }))!;
    const listAgg = (await c.storage.getAggregate({ kind: "adoption-looks", id: "installation" }))!;
    const { told: _t, runs: _r, pages: _p, tasks: _k, notified: _n, doneAt: _d, ...rest } = lookAgg.body as Record<string, unknown>;
    void _t; void _r; void _p; void _k; void _n; void _d;
    await c.storage.applyOperation(op("rewind", { changes: [
      { type: "update", ref: { kind: "adoption-look", id: adp }, expectedRevision: lookAgg.revision, body: { ...rest, state: "looking", pages: 0, runs: 0, tasks: {}, told: 0 } as never },
      { type: "update", ref: { kind: "adoption-looks", id: "installation" }, expectedRevision: listAgg.revision, body: { pending: [adp] } as never },
    ] }));
    await c.close();
    c = await open();
    assert.match(await text(), /The look at the work that ran this version is not finished yet/);
    const tick = await c.dispatch!.dispatcher.tick();
    assert.equal(tick.loops.find((l) => l.name === "adoptions.looks")?.ok, true, JSON.stringify(tick.loops.find((l) => l.name === "adoptions.looks")));
    const again = (await affected()).result!.item;
    assert.deepEqual([again.state, again.runs, again.told, again.notified, again.tasks], ["done", 4, 2, true, look.tasks]);
    assert.deepEqual([(await steps(tPaused)).length, (await steps(tOpen)).length, (await steps(tDone)).length], [1, 1, 0], "no task is told twice");
    assert.deepEqual((await notices()).map((x) => x.count), [1], "the owner is not told twice");
    assert.deepEqual(((await c.storage.getAggregate({ kind: "adoption-looks", id: "installation" }))!.body as { pending: string[] }).pending, []);
    // Nothing pending: the next tick's sweep writes nothing.
    const before = (await c.storage.getAggregate({ kind: "adoption-looks", id: "installation" }))!.revision;
    assert.equal((await c.dispatch!.dispatcher.tick()).loops.find((l) => l.name === "adoptions.looks")?.ok, true);
    assert.equal((await c.storage.getAggregate({ kind: "adoption-looks", id: "installation" }))!.revision, before);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
