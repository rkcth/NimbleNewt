import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CatalogService } from "../catalog/index.js";
import { DeskService } from "../context/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { EnvironmentService } from "../environments/index.js";
import { ExperimentService } from "../experiments/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { AdoptionService, targetKey, type AdoptionBody, type AdoptionOptions } from "./index.js";

// Card B05, first slice: an improved experiment's practice or one exact shared tool version is adopted only after an independent review under a grant the reviewer already holds; monitoring that shows a
// regression withdraws it in the same write, so it is no longer in force; adopting never publishes a tool. Real storage on each backend; every transition is done by a fresh service over the same storage
// (as after a controller restart). The only clock is the test's, and nothing sleeps.

after(stopServer);

let now = Date.parse("2026-11-27T10:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const hex = (c: string): string => c.repeat(64);

const PROPOSAL = { problem: "reviews send back handlers without error tests", affectedWork: "request handler reviews", change: "add a checklist to the coder prompt", effort: "one afternoon", runningCost: "no extra tokens", benefit: "less rework", evaluation: "the same five handler tasks", stoppingCondition: "two runs" };
const criteria = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  baseline: { label: "prompt v4", ref: "commit abc123", digest: hex("a") }, evaluator: { label: "review rubric", ref: "rubric 2", digest: hex("b") },
  cases: [{ id: "c1", text: "handler with a missing field" }], baselinePassing: ["c1"],
  baselineMetrics: { timeToAcceptedSeconds: 100, reworkCount: 4, adoptionCount: 5 }, budget: { maxRuns: 3, maxCost: 30 }, minRuns: 2, minImprovementPct: 5, maxRegressionPct: 0, ...over,
});
const GOOD = { timeToAcceptedSeconds: 80, reworkCount: 3, adoptionCount: 6 };
const GUARD = `sha256:${hex("9")}`;
const MANIFEST = { base: { name: "nimblenewt-base", version: "1.0.0", digest: `sha256:${hex("1")}` }, packages: [], skills: [], capabilities: ["desk.read"], configuration: { installation: 1 }, limits: { cpus: 1, memoryMb: 512, diskMb: 1024, processes: 64 }, protectedExtensions: [{ name: "nimblenewt.guard", digest: GUARD }] };
const SKILL = { purpose: "fetch a page", input: { type: "object" }, output: { type: "object" }, os: ["linux", "darwin"], arch: ["x64", "arm64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 256, seconds: 60 }, cancellation: "cooperative", recovery: "restart" };
const PRACTICE = { kind: "practice" };
const tool = (name = "toolbox.fetch", version = "1.0.0") => ({ kind: "tool", name, version });

interface Ctx {
  owner: Principal; mgr: Principal; mgr2: Principal; dev: Principal; reader: Principal; eve: Principal; maint: Principal; author: Principal;
  a: string; b: string; storage: ControllerStorage; epoch: number; cat: CatalogService; exps: ExperimentService;
  /** A fresh adoption service over the same storage, as after a restart. */
  make(o?: { tools?: AdoptionOptions["tools"] | undefined }): AdoptionService;
  /** An experiment of project A proposed by dev, pinned by mgr, run twice and concluded by mgr: `improved` unless other metrics are given. */
  experiment(metrics?: Record<string, number>, over?: Record<string, unknown>, proposer?: Principal): Promise<string>;
  ask(experimentId: string, target?: Record<string, unknown>, by?: Principal): Promise<string>;
  rev(id: string): Promise<number>;
  approve(id: string, by?: Principal): Promise<{ revision: number }>;
  monitor(id: string, metrics?: Record<string, number>, by?: Principal): Promise<{ report: number; status: string; regressed: string[] }>;
  body(id: string): Promise<AdoptionBody & { revision: number }>;
}

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-11-27T10:00:00.000Z");
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
        const make = (o: { tools?: AdoptionOptions["tools"] | undefined } = {}) => AdoptionService.withEpoch(world.storage, epoch, { ...options, ...("tools" in o ? (o.tools === undefined ? {} : { tools: o.tools }) : { tools: cat }) });
        const desk = (p: string): Grant[] => [{ action: "desk.write", project: p }, { action: "desk.read", project: p }];
        const mgr = await enroll("mgr", [{ action: "meeting.manage", project: a }]);
        const mgr2 = await enroll("mgr2", [{ action: "meeting.manage", project: a }, { action: "catalog.read", project: "*" }]);
        const dev = await enroll("dev", [{ action: "meeting.agenda", project: a }]);
        const reader = await enroll("reader", [{ action: "meeting.read", project: a }]);
        const eve = await enroll("eve", [{ action: "meeting.manage", project: b }, { action: "toolbox.manage", project: "*" }, { action: "catalog.read", project: "*" }]);
        const maint = await enroll("maint", [{ action: "meeting.manage", project: a }, { action: "toolbox.manage", project: "*" }, { action: "catalog.read", project: "*" }]);
        const author = await enroll("author", [...desk(a), { action: "meeting.manage", project: a }, { action: "toolbox.manage", project: "*" }, { action: "catalog.read", project: "*" }]);
        await env.change(owner, { commandId: cid("env"), agentId: dev.id, manifest: MANIFEST, reason: "first" });
        // The shared toolbox: toolbox.fetch 1.0.0 and 1.1.0 (revoked), released by the owner from author's work; and a protected nimblenewt.fetch.
        const note = (await desks.write(author, { commandId: cid("w"), projectId: a, kind: "note", title: "fetch", body: "Use fetch to read a page.", visibility: "shared", status: "accepted" } as never)).id;
        for (const [nm, v] of [["toolbox.fetch", "1.0.0"], ["toolbox.fetch", "1.1.0"], ["nimblenewt.fetch", "1.0.0"]] as const) await cat.register(owner, { commandId: cid("r"), name: nm, kind: "skill", version: v, manifest: SKILL, instructionsRecordId: note } as never);
        await cat.revoke(owner, { commandId: cid("v"), name: "toolbox.fetch", version: "1.1.0", reason: "it broke pages" });
        const ctx: Ctx = {
          owner, mgr, mgr2, dev, reader, eve, maint, author, a, b, storage: world.storage, epoch, cat, exps, make,
          experiment: async (metrics = GOOD, over = {}, proposer = dev) => {
            const id = (await exps.propose(proposer, { commandId: cid("x"), projectId: a, title: "Checklist prompt", proposal: PROPOSAL, affectedKey: `reviews ${n}` } as never)).id;
            await exps.pin(mgr, { commandId: cid("p"), experimentId: id, expectedRevision: (await exps.get(owner, id))!.revision, criteria: criteria(over) } as never);
            for (let i = 0; i < 2; i++) await exps.recordRun(proposer === dev ? dev : owner, { commandId: cid("r"), experimentId: id, environment: { agentId: dev.id, revision: 1, observed: { "nimblenewt.guard": GUARD }, disposable: true }, cost: 1, metrics, cases: [{ id: "c1", passed: true }] } as never);
            await exps.conclude(mgr, { commandId: cid("c"), experimentId: id, expectedRevision: (await exps.get(owner, id))!.revision, finding: "read the runs" });
            return id;
          },
          ask: async (experimentId, target = PRACTICE, by = dev) => (await make().request(by, { commandId: cid("q"), experimentId, target, reason: "it helped" })).id,
          rev: async (id) => (await make().get(owner, id))!.revision,
          approve: async (id, by = mgr2) => make().approve(by, { commandId: cid("ap"), adoptionId: id, expectedRevision: await ctx.rev(id), review: "the runs and the baseline agree" }),
          monitor: async (id, metrics = GOOD, by = dev) => make().monitor(by, { commandId: cid("m"), adoptionId: id, metrics }),
          body: async (id) => (await make().get(owner, id))! as unknown as AdoptionBody & { revision: number },
        };
        await body(ctx);
      } finally { await world.close(); }
    });

  suite("only an experiment the controller judged improved is adopted; the request is scoped, bounded, replays, and one adoption per target is open", async (c) => {
    const exp = await c.experiment();
    const id = await c.ask(exp);
    const got = await c.body(id);
    assert.deepEqual([got.status, got.requestedBy, got.experimentId, got.target, got.projectId, got.reportCount], ["requested", c.dev.id, exp, { kind: "practice" }, c.a, 0]);
    assert.equal(await c.make().inForce(c.owner, { projectId: c.a, experimentId: exp, target: PRACTICE }), undefined, "asked is not in force");
    // A repeat after a restart is the same request; the same command ID with other words is a conflict.
    const first = await c.make().request(c.reader, { commandId: "same", experimentId: exp, target: tool(), reason: "r" });
    const again = await c.make().request(c.reader, { commandId: "same", experimentId: exp, target: tool(), reason: "r" });
    assert.deepEqual([again.id, again.replayed, first.replayed], [first.id, true, false]);
    await refuses("command_conflict", () => c.make().request(c.reader, { commandId: "same", experimentId: exp, target: tool(), reason: "other" }));
    // One open adoption per target; another target of the same experiment is its own.
    await refuses("invalid_command", () => c.ask(exp), /already has an open adoption/);
    await refuses("invalid_command", () => c.ask(exp, tool(), c.mgr), /already has an open adoption/);
    // Not improved: worse, no change, inconclusive, still running, or unknown.
    const worse = await c.experiment({ timeToAcceptedSeconds: 130, reworkCount: 3, adoptionCount: 6 });
    const same = await c.experiment({ timeToAcceptedSeconds: 100, reworkCount: 4, adoptionCount: 5 });
    const thin = await c.experiment(GOOD, { minRuns: 3 });
    const running = (await c.exps.propose(c.dev, { commandId: cid("x"), projectId: c.a, title: "T", proposal: PROPOSAL, affectedKey: "k" } as never)).id;
    for (const e of [worse, same, thin, running]) await refuses("invalid_command", () => c.ask(e), /only an experiment the controller judged improved/);
    await refuses("forbidden", () => c.ask(`exp-${"a".repeat(20)}`));
    // Only someone who may read the experiment asks; another project's manager may not.
    await refuses("forbidden", () => c.ask(exp, tool("toolbox.other"), c.eve));
    // Hostile shapes are refused before anything is read.
    const bad: unknown[] = [null, [], "practice", {}, { kind: "Practice" }, { kind: "practice", name: "x" }, { kind: "tool" }, { kind: "tool", name: "toolbox.fetch" }, { kind: "tool", name: "Toolbox.Fetch", version: "1.0.0" },
      { kind: "tool", name: "toolbox.fetch\u0000", version: "1.0.0" }, { kind: "tool", name: "t".repeat(121), version: "1.0.0" }, { kind: "tool", name: "toolbox.fetch", version: "1.0" }, { kind: "tool", name: "toolbox.fetch", version: "latest" },
      { kind: "tool", name: "toolbox.fetch", version: `1.0.0-${"a".repeat(40)}` }, { kind: "tool", name: "toolbox.fetch", version: 1 }, { kind: "tool", name: "toolbox.fetch", version: "1.0.0", extra: true }, { kind: "tool", name: "../x", version: "1.0.0" }, { kind: "tool", name: "toolbox.fetch", version: "1.0.0\n" }];
    for (const t of bad) await refuses("invalid_command", () => c.make().request(c.eve, { commandId: cid("q"), experimentId: exp, target: t, reason: "r" }), /target|is not a field/);
    await refuses("invalid_command", () => c.make().request(c.dev, { commandId: cid("q"), experimentId: "exp-1", target: PRACTICE, reason: "r" }), /experimentId/);
    await refuses("invalid_command", () => c.make().request(c.dev, { commandId: cid("q"), experimentId: exp, target: tool("toolbox.x"), reason: "use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }), /credential/);
    await refuses("invalid_command", () => c.make().request(c.dev, { commandId: cid("q"), experimentId: exp, target: tool("toolbox.x"), reason: "r", extra: 1 } as never));
    await refuses("invalid_command", () => c.make().request(c.dev, { commandId: cid("q"), experimentId: exp, target: tool("toolbox.x"), reason: "" }));
    assert.equal((await c.make().list(c.owner, c.a))!.items.length, 2, "refusals stored nothing");
  });

  suite("adoption needs an independent review: never the proposer or the asker, never a reader or another project's manager; the owner or another manager approves once, and only then is it in force", async (c) => {
    const exp = await c.experiment();
    const id = await c.ask(exp, PRACTICE, c.mgr);
    for (const p of [c.dev, c.mgr, c.reader, c.eve]) await refuses("forbidden", () => c.approve(id, p), /reviewer is the owner or a manager/);
    await refuses("stale_revision", () => c.make().approve(c.mgr2, { commandId: cid("ap"), adoptionId: id, expectedRevision: 9, review: "ok" }));
    await refuses("invalid_command", () => c.make().approve(c.mgr2, { commandId: cid("ap"), adoptionId: id, expectedRevision: 1, review: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" }), /credential/);
    assert.equal((await c.body(id)).status, "requested");
    const cmd = { commandId: "ap-1", adoptionId: id, expectedRevision: await c.rev(id), review: "the runs agree" };
    const ok = await c.make().approve(c.mgr2, cmd);
    const replay = await c.make().approve(c.mgr2, cmd);
    assert.equal(replay.revision, ok.revision, "a repeat after a restart answers from the record");
    const got = await c.body(id);
    assert.deepEqual([got.status, got.approvedBy, got.review, got.grantBasis, got.targetDigest], ["active", c.mgr2.id, "the runs agree", ["meeting.manage"], undefined]);
    assert.deepEqual(await c.make().inForce(c.reader, { projectId: c.a, experimentId: exp, target: PRACTICE }), { adoptionId: id, experimentId: exp, revision: got.revision });
    assert.equal(await c.make().inForce(c.reader, { projectId: c.a, experimentId: await c.experiment(), target: PRACTICE }), undefined, "a practice is its own experiment's");
    assert.equal(await c.make().inForce(c.eve, { projectId: c.a, experimentId: exp, target: PRACTICE }), undefined, "another project's manager sees nothing");
    await refuses("invalid_command", () => c.approve(id, c.owner), /only an asked adoption is approved/);
    // A manager who proposed the experiment is not its adoption's reviewer, though it holds meeting.manage and did not ask.
    const byMgr = await c.experiment(GOOD, {}, c.mgr2);
    const askedOfMgr = await c.ask(byMgr, PRACTICE, c.reader);
    await refuses("forbidden", () => c.approve(askedOfMgr, c.mgr2), /reviewer is the owner or a manager/);
    await c.approve(askedOfMgr, c.maint);
    // The owner is always an independent reviewer, even of its own request.
    const exp2 = await c.experiment();
    const mine = await c.ask(exp2, PRACTICE, c.owner);
    await c.approve(mine, c.owner);
    assert.deepEqual((await c.body(mine)).grantBasis, ["owner"]);
    // Criteria changed in storage after the verdict: neither asked nor approved.
    const exp3 = await c.experiment();
    const asked = await c.ask(exp3);
    const runner = new CommandRunner(c.storage, c.epoch, options);
    const found = (await runner.get("experiment", exp3))!;
    await runner.command("test.tamper", { commandId: cid("t"), actor: c.owner.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "experiment", id: exp3 }, creates: false, changes: [{ type: "update" as const, ref: { kind: "experiment", id: exp3 }, expectedRevision: found.revision, body: { ...(found.body as object), criteria: { ...((found.body as { criteria: object }).criteria), maxRegressionPct: 100 } } as never }], detail: {} }) }));
    await refuses("integrity", () => c.approve(asked));
    await refuses("integrity", () => c.ask(exp3, tool()));
  });

  suite("a tool is adopted only as a shared, published, unrevoked version, by a reviewer who already holds toolbox.manage and did not write it; adopting publishes nothing", async (c) => {
    const exp = await c.experiment();
    const entry = async () => JSON.stringify((await c.cat.list(c.owner)).sort((x, y) => (x.name < y.name ? -1 : 1)));
    const before = await entry();
    const id = await c.ask(exp, tool());
    await refuses("forbidden", () => c.approve(id, c.mgr2), /toolbox\.manage already held/);
    await refuses("forbidden", () => c.approve(id, c.author), /not independent/);
    await c.approve(id, c.maint);
    const got = await c.body(id);
    assert.deepEqual([got.status, got.grantBasis, got.targetDigest], ["active", ["meeting.manage", "toolbox.manage"], (await c.cat.get(c.owner, "toolbox.fetch", "1.0.0"))!.digest]);
    assert.equal((await c.make().inForce(c.owner, { projectId: c.a, experimentId: exp, target: tool() }))?.targetDigest, got.targetDigest);
    // A tool version is one target in the project: in force whichever experiment is named, and another experiment cannot open it again meanwhile.
    const other = await c.experiment();
    assert.equal((await c.make().inForce(c.owner, { projectId: c.a, target: tool() }))?.experimentId, exp);
    await refuses("invalid_command", () => c.ask(other, tool()), /already has an open adoption/);
    // A finished improvement task's tool that was never published is not published by adopting it; a revoked or protected version is refused; nothing in the catalog changed.
    const unpublished = await c.ask(exp, tool("toolbox.newtool"));
    await refuses("not_found", () => c.approve(unpublished, c.maint), /adopting does not publish a tool/);
    await refuses("not_found", async () => c.approve(await c.ask(exp, tool("toolbox.fetch", "2.0.0")), c.maint), /not a published version/);
    await refuses("invalid_command", async () => c.approve(await c.ask(exp, tool("toolbox.fetch", "1.1.0")), c.maint), /revoked/);
    await refuses("invalid_command", async () => c.approve(await c.ask(exp, tool("nimblenewt.fetch")), c.owner), /not a shared toolbox tool/);
    assert.equal(await c.cat.get(c.owner, "toolbox.newtool"), undefined);
    assert.equal(await entry(), before, "the catalog is as it was");
    assert.equal((await c.body(unpublished)).status, "requested");
    // Without the catalog no tool is adopted (fail closed); a practice still is.
    await c.make().withdraw(c.owner, { commandId: cid("w"), adoptionId: id, expectedRevision: await c.rev(id), reason: "make room" });
    const exp2 = await c.experiment();
    // (dev has 4 requests waiting here; the next ones are asked by the reader, since one asker has at most 5 waiting.)
    const t2 = await c.ask(exp2, tool(), c.reader);
    await refuses("unavailable", async () => c.make({ tools: undefined }).approve(c.maint, { commandId: cid("ap"), adoptionId: t2, expectedRevision: await c.rev(t2), review: "r" }));
    const p2 = await c.ask(exp2, PRACTICE, c.reader);
    await c.make({ tools: undefined }).approve(c.maint, { commandId: cid("ap"), adoptionId: p2, expectedRevision: await c.rev(p2), review: "r" });
    assert.equal((await c.body(p2)).status, "active");
    // A catalog that cannot answer is no answer: refused, not adopted.
    await c.make().decline(c.owner, { commandId: cid("d"), adoptionId: t2, expectedRevision: await c.rev(t2), reason: "make room" });
    const t3 = await c.ask(await c.experiment(), tool(), c.reader);
    await refuses("not_found", async () => c.make({ tools: { get: async () => { throw new DomainError("forbidden", "no"); } } }).approve(c.maint, { commandId: cid("ap"), adoptionId: t3, expectedRevision: await c.rev(t3), review: "r" }));
    await assert.rejects(() => c.make({ tools: { get: async () => { throw new Error("disk gone"); } } }).approve(c.maint, { commandId: cid("ap"), adoptionId: t3, expectedRevision: 1, review: "r" }), /disk gone/);
    // A catalog answering another name or version than asked is not that version.
    const real = (await c.cat.get(c.owner, "toolbox.fetch", "1.0.0"))!;
    await refuses("not_found", () => c.make({ tools: { get: async () => ({ ...real, version: "0.9.0" }) as never } }).approve(c.maint, { commandId: cid("ap"), adoptionId: t3, expectedRevision: 1, review: "r" }));
    await refuses("not_found", () => c.make({ tools: { get: async () => ({ ...real, name: "toolbox.other" }) as never } }).approve(c.maint, { commandId: cid("ap"), adoptionId: t3, expectedRevision: 1, review: "r" }));
    assert.equal((await c.body(t3)).status, "requested");
  });

  suite("monitoring: a report within the baseline keeps it in force; a regression withdraws it in the same write, so it is no longer used, and the target is free for a new, reviewed request", async (c) => {
    const exp = await c.experiment(GOOD, { maxRegressionPct: 10 });
    const id = await c.ask(exp);
    await refuses("invalid_command", () => c.monitor(id), /only an adoption in force is monitored/);
    await c.approve(id);
    // Exactly the pinned metrics, each a bounded number.
    for (const m of [{}, { timeToAcceptedSeconds: 90 }, { ...GOOD, costPerSuccess: 1 }, { ...GOOD, timeToAcceptedSeconds: -1 }, { ...GOOD, reworkCount: Number.NaN }, { ...GOOD, reworkCount: "3" }, { ...GOOD, reworkCount: 1e10 }] as Record<string, number>[]) await refuses("invalid_command", () => c.monitor(id, m), /metrics/);
    await refuses("invalid_command", () => c.monitor(id, [] as never), /metrics/);
    await refuses("invalid_command", () => c.monitor(id, JSON.parse(`{"__proto__":{"timeToAcceptedSeconds":1},"reworkCount":3,"adoptionCount":5}`)), /__proto__: is not a field/);
    // Who may report: the asker, a manager, the owner; not a reader or another project's manager.
    for (const p of [c.reader, c.eve]) await refuses("forbidden", () => c.monitor(id, GOOD, p));
    // Within the pinned tolerance (10 percent): 105 s against 100, adoption 4.6 against 5.
    const within = await c.monitor(id, { timeToAcceptedSeconds: 105, reworkCount: 4, adoptionCount: 4.6 }, c.mgr);
    assert.deepEqual(within, { report: 1, status: "active", regressed: [] });
    now += 60_000;
    // A restart between reports; the second is from the owner. Rework 5 against 4 is 25 percent worse: a regression.
    const cmd = { commandId: "m-reg", adoptionId: id, metrics: { timeToAcceptedSeconds: 90, reworkCount: 5, adoptionCount: 6 } };
    const out = await c.make().monitor(c.owner, cmd);
    assert.deepEqual(out, { report: 2, status: "withdrawn", regressed: ["reworkCount"] });
    const got = await c.body(id);
    assert.deepEqual([got.status, got.withdrawnWhy, got.withdrawnBy, got.reportCount, got.reports.map((r) => r.n), got.reports[1]!.betterPct], ["withdrawn", "regression", c.owner.id, 2, [1, 2], { timeToAcceptedSeconds: 10, reworkCount: -25, adoptionCount: 20 }]);
    assert.match(got.history.at(-1)!.cause!, /regression: reworkCount/);
    assert.equal(await c.make().inForce(c.owner, { projectId: c.a, experimentId: exp, target: PRACTICE }), undefined, "regression stops future use");
    assert.deepEqual(await c.make().monitor(c.owner, cmd), out, "a repeat after a restart is the same report");
    await refuses("invalid_command", () => c.monitor(id), /withdrawn/);
    await refuses("invalid_command", () => c.approve(id, c.owner), /withdrawn/);
    // The experiment and its verdict are not touched by a withdrawal.
    assert.equal((await c.exps.get(c.owner, exp))!.result!.verdict, "improved");
    // Adopting again is a new request with its own review.
    const again = await c.ask(exp);
    assert.notEqual(again, id);
    assert.equal(await c.make().inForce(c.owner, { projectId: c.a, experimentId: exp, target: PRACTICE }), undefined);
    await c.approve(again);
    assert.equal((await c.make().inForce(c.owner, { projectId: c.a, experimentId: exp, target: PRACTICE }))?.adoptionId, again);
    // Adoption is better higher: fewer adoptions than the baseline beyond the tolerance is a regression too.
    assert.deepEqual((await c.monitor(again, { timeToAcceptedSeconds: 90, reworkCount: 3, adoptionCount: 4 })).regressed, ["adoptionCount"]);
  });

  suite("monitoring with no tolerance: any metric worse than the baseline withdraws; reports are bounded and counted; a very old repeat answers report 0", async (c) => {
    const exp = await c.experiment();
    const id = await c.ask(exp);
    await c.approve(id);
    // Equal to the baseline is not a regression.
    assert.equal((await c.monitor(id, { timeToAcceptedSeconds: 100, reworkCount: 4, adoptionCount: 5 })).status, "active");
    const first = { commandId: "m-first", adoptionId: id, metrics: GOOD };
    await c.make().monitor(c.dev, first);
    for (let i = 0; i < 22; i++) await c.monitor(id);
    const got = await c.body(id);
    assert.deepEqual([got.reportCount, got.reports.length, got.reports[0]!.n, got.status], [24, 20, 5, "active"]);
    assert.deepEqual(await c.make().monitor(c.dev, first), { report: 0, status: "active", regressed: [] });
    assert.deepEqual((await c.monitor(id, { timeToAcceptedSeconds: 100.5, reworkCount: 3, adoptionCount: 6 })).status, "withdrawn");
  });

  suite("decline and withdraw: who may, from which status, the target freed, nothing deleted or undone", async (c) => {
    const exp = await c.experiment();
    const id = await c.ask(exp, PRACTICE, c.mgr);
    // Declining is a reviewer's (or the asker's): not the proposer, a reader or another project's manager.
    for (const p of [c.dev, c.reader, c.eve]) await refuses("forbidden", () => c.make().decline(p, { commandId: cid("d"), adoptionId: id, expectedRevision: 1, reason: "no" }));
    await refuses("invalid_command", () => c.make().withdraw(c.owner, { commandId: cid("w"), adoptionId: id, expectedRevision: 1, reason: "no" }), /only an in-force adoption is withdrawn/);
    await c.make().decline(c.mgr, { commandId: cid("d"), adoptionId: id, expectedRevision: 1, reason: "taken back" });
    assert.deepEqual([(await c.body(id)).status, (await c.body(id)).history.at(-1)!.cause], ["declined", "taken back"]);
    await refuses("invalid_command", () => c.approve(id, c.owner), /declined/);
    const id2 = await c.ask(exp);
    await c.make().decline(c.mgr2, { commandId: cid("d"), adoptionId: id2, expectedRevision: 1, reason: "not yet" });
    const id3 = await c.ask(exp);
    await c.approve(id3);
    await refuses("invalid_command", async () => c.make().decline(c.owner, { commandId: cid("d"), adoptionId: id3, expectedRevision: await c.rev(id3), reason: "no" }), /only an asked adoption is declined/);
    // Withdrawing narrows what is in force: any manager (even the experiment's judge), the owner or the asker; not a reader or another project's manager.
    for (const p of [c.reader, c.eve]) await refuses("forbidden", () => c.make().withdraw(p, { commandId: cid("w"), adoptionId: id3, expectedRevision: 3, reason: "no" }));
    await refuses("stale_revision", () => c.make().withdraw(c.mgr, { commandId: cid("w"), adoptionId: id3, expectedRevision: 1, reason: "no" }));
    await c.make().withdraw(c.mgr, { commandId: cid("w"), adoptionId: id3, expectedRevision: await c.rev(id3), reason: "the team moved on" });
    const got = await c.body(id3);
    assert.deepEqual([got.status, got.withdrawnWhy, got.withdrawnBy], ["withdrawn", "decision", c.mgr.id]);
    assert.equal(await c.make().inForce(c.owner, { projectId: c.a, experimentId: exp, target: PRACTICE }), undefined);
    const listed = (await c.make().list(c.reader, c.a))!.items.map((x) => x.status);
    assert.deepEqual(listed, ["declined", "declined", "withdrawn"], "nothing is deleted");
    assert.deepEqual((await c.make().list(c.reader, c.a, { status: "withdrawn" }))!.items.map((x) => x.id), [id3]);
    // The asker withdraws its own.
    const id4 = await c.ask(exp);
    await c.approve(id4);
    await c.make().withdraw(c.dev, { commandId: cid("w"), adoptionId: id4, expectedRevision: await c.rev(id4), reason: "mine" });
    assert.equal((await c.body(id4)).status, "withdrawn");
    // A manager who proposed the experiment is not its adoption's reviewer, so it does not decline one it did not ask for (another manager does).
    const byMgr = await c.experiment(GOOD, {}, c.mgr2);
    const asked = await c.ask(byMgr, PRACTICE, c.reader);
    await refuses("forbidden", () => c.make().decline(c.mgr2, { commandId: cid("d"), adoptionId: asked, expectedRevision: 1, reason: "no" }), /may not decline/);
    await c.make().decline(c.mgr, { commandId: cid("d"), adoptionId: asked, expectedRevision: 1, reason: "not yet" });
    assert.equal((await c.body(asked)).status, "declined");
  });

  suite("reads, pages and races: readers and the asker read, others see nothing; two reviewers or two askers at once give one result", async (c) => {
    const exp = await c.experiment();
    const id = await c.ask(exp);
    assert.notEqual(await c.make().get(c.dev, id), undefined, "the asker reads its own");
    for (const p of [c.eve]) { assert.equal(await c.make().get(p, id), undefined); assert.equal(await c.make().list(p, c.a), undefined); }
    assert.equal(await c.make().list(c.dev, c.a), undefined, "an agenda holder does not list the project's adoptions");
    assert.equal(await c.make().get(c.owner, "adp-x"), undefined);
    await refuses("invalid_command", () => c.make().list(c.owner, c.a, { status: "gone" }));
    await refuses("invalid_command", () => c.make().list(c.owner, c.a, { limit: 0 }));
    await refuses("invalid_command", () => c.make().list(c.owner, c.a, { afterId: "adp-zzzzzzzzzzzzzzzzzzzz" }));
    await refuses("invalid_command", () => c.make().inForce(c.owner, { projectId: c.a, experimentId: exp, target: { kind: "tool" } }));
    const others = [await c.ask(exp, tool()), await c.ask(exp, tool("toolbox.b"))];
    const page = (await c.make().list(c.owner, c.a, { limit: 2 }))!;
    assert.deepEqual([page.items.map((x) => x.id), page.next], [[id, others[0]], others[0]]);
    assert.deepEqual((await c.make().list(c.owner, c.a, { afterId: page.next! }))!.items.map((x) => x.id), [others[1]]);
    // Two reviewers at once: one approves, the other is told it is no longer asked (or stale).
    const rev = await c.rev(id);
    const both = await Promise.allSettled([c.make().approve(c.mgr2, { commandId: cid("ap"), adoptionId: id, expectedRevision: rev, review: "a" }), c.make().approve(c.owner, { commandId: cid("ap"), adoptionId: id, expectedRevision: rev, review: "b" })]);
    assert.equal(both.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(both));
    // Two askers of one target at once: one open adoption.
    const exp2 = await c.experiment();
    const asks = await Promise.allSettled([c.ask(exp2, PRACTICE, c.dev), c.ask(exp2, PRACTICE, c.mgr)]);
    assert.equal(asks.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(asks));
    assert.equal(Object.keys(((await new CommandRunner(c.storage, c.epoch, options).get("adoption-index", c.a))!.body as { open: object }).open).filter((k) => k === targetKey(exp2, { kind: "practice" })).length, 1);
  });

  suite("a report within the baseline and a regression at once: the regression withdraws it whichever is written first, each report names its reporter, and a later good report does not put it back", async (c) => {
    const exp = await c.experiment();
    const id = await c.ask(exp);
    await c.approve(id);
    const both = await Promise.allSettled([c.monitor(id, GOOD, c.dev), c.monitor(id, { timeToAcceptedSeconds: 90, reworkCount: 5, adoptionCount: 6 }, c.mgr)]);
    assert.equal(both[1]!.status, "fulfilled", JSON.stringify(both));
    const got = await c.body(id);
    assert.deepEqual([got.status, got.withdrawnWhy, got.withdrawnBy], ["withdrawn", "regression", c.mgr.id]);
    const regressed = got.reports.filter((r) => r.regressed.length > 0);
    assert.deepEqual(regressed.map((r) => [r.by, r.regressed]), [[c.mgr.id, ["reworkCount"]]]);
    if (both[0]!.status === "rejected") assert.match(String((both[0] as PromiseRejectedResult).reason), /withdrawn/);
    else assert.deepEqual(got.reports.map((r) => r.by), [c.dev.id, c.mgr.id], "the good report was written first");
    // The withdrawal is final: a good report afterwards (from the owner too) is refused, and nothing is in force.
    for (const p of [c.dev, c.owner]) await refuses("invalid_command", () => c.monitor(id, GOOD, p), /withdrawn/);
    assert.equal(await c.make().inForce(c.owner, { projectId: c.a, experimentId: exp, target: PRACTICE }), undefined);
    assert.equal((await c.body(id)).reportCount, got.reportCount);
  });

  suite("a task credential of another project acts for nobody here; criteria re-sealed after the request, a registrant or an executable's author as reviewer, and the project bound are refused", async (c) => {
    const exp = await c.experiment();
    // The asker (and proposer) authenticated with a task credential of project B: its own adoption in A is not its to read, take back, report on or withdraw, and it cannot ask again.
    const inB = (p: Principal): Principal => ({ ...p, taskScope: { taskId: `task-${"b".repeat(20)}`, projectId: c.b } });
    const id = await c.ask(exp);
    assert.equal(await c.make().get(inB(c.dev), id), undefined);
    await refuses("forbidden", () => c.make().decline(inB(c.dev), { commandId: cid("d"), adoptionId: id, expectedRevision: 1, reason: "mine" }));
    await refuses("forbidden", () => c.make().request(inB(c.dev), { commandId: cid("q"), experimentId: exp, target: tool("toolbox.x"), reason: "r" }));
    await c.approve(id);
    await refuses("forbidden", () => c.monitor(id, GOOD, inB(c.dev)));
    await refuses("forbidden", async () => c.make().withdraw(inB(c.dev), { commandId: cid("w"), adoptionId: id, expectedRevision: await c.rev(id), reason: "mine" }));
    assert.equal((await c.body(id)).status, "active");
    // An asker that no longer holds meeting.read or meeting.agenda in the project does not report (a manager still does).
    const byReader = await c.ask(await c.experiment(), PRACTICE, c.reader);
    await c.approve(byReader);
    await refuses("forbidden", () => c.monitor(byReader, GOOD, { ...c.reader, grants: [] }));
    assert.equal((await c.monitor(byReader, GOOD, c.reader)).status, "active");
    // Criteria rewritten and sealed again in storage after the adoption was asked (or approved): not the criteria it was asked on, so not approved and not monitored.
    const reseal = async (e: string, seal = true) => {
      const runner = new CommandRunner(c.storage, c.epoch, options);
      const found = (await runner.get("experiment", e))!;
      const changed = { ...((found.body as { criteria: object }).criteria), maxRegressionPct: 100 };
      const { sealOf } = await import("../experiments/experiments.js");
      await runner.command("test.reseal", { commandId: cid("t"), actor: c.owner.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "experiment", id: e }, creates: false, changes: [{ type: "update" as const, ref: { kind: "experiment", id: e }, expectedRevision: found.revision, body: { ...(found.body as object), criteria: changed, ...(seal ? { criteriaDigest: sealOf(changed as never) } : {}) } as never }], detail: {} }) }));
    };
    const exp2 = await c.experiment();
    const asked = await c.ask(exp2);
    await reseal(exp2);
    await refuses("integrity", () => c.approve(asked, c.owner), /not the ones it was asked on/);
    // In force: criteria changed under the same seal, then sealed again; each is refused.
    await reseal(exp, false);
    await refuses("integrity", () => c.monitor(id, GOOD, c.owner), /no longer match/);
    await reseal(exp);
    await refuses("integrity", () => c.monitor(id, GOOD, c.owner), /no longer match/);
    // A reviewer who registered the version, or wrote its executable, is not independent (the owner always is).
    const real = (await c.cat.get(c.owner, "toolbox.fetch", "1.0.0"))!;
    const t = await c.ask(await c.experiment(), tool());
    const as = (over: Record<string, unknown>) => c.make({ tools: { get: async () => ({ ...real, ...over }) as never } });
    await refuses("forbidden", async () => as({ registeredBy: c.maint.id }).approve(c.maint, { commandId: cid("ap"), adoptionId: t, expectedRevision: await c.rev(t), review: "r" }), /not independent/);
    await refuses("forbidden", async () => as({ executable: { ...real.instructional, author: c.maint.id } }).approve(c.maint, { commandId: cid("ap"), adoptionId: t, expectedRevision: await c.rev(t), review: "r" }), /not independent/);
    assert.equal((await c.body(t)).status, "requested");
    await as({ registeredBy: c.owner.id }).approve(c.owner, { commandId: cid("ap"), adoptionId: t, expectedRevision: await c.rev(t), review: "r" });
    // A list of 300 whose oldest are ended (here IDs with no open adoption) no longer refuses: the oldest ended one leaves the list in the same write and is counted as archived (the retention slice).
    const runner = new CommandRunner(c.storage, c.epoch, options);
    const index = (await runner.get("adoption-index", c.a))!;
    const ids = (index.body as { ids: string[] }).ids;
    const full = [...ids, ...Array.from({ length: 300 - ids.length }, (_, i) => `adp-${String.fromCharCode(97 + (i % 26)).repeat(19)}${String.fromCharCode(97 + Math.floor(i / 26))}`)];
    await runner.command("test.fill", { commandId: cid("t"), actor: c.owner.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "adoption-index", id: c.a }, creates: false, changes: [{ type: "update" as const, ref: { kind: "adoption-index", id: c.a }, expectedRevision: index.revision, body: { ...(index.body as object), ids: full } as never }], detail: {} }) }));
    const next = await c.ask(await c.experiment());
    const after = (await runner.get("adoption-index", c.a))!.body as { ids: string[]; archived: number };
    const openIds = Object.values((index.body as { open: Record<string, string> }).open);
    const dropped = full.find((x) => !openIds.includes(x))!;
    assert.deepEqual([after.ids.length, after.ids.at(-1), after.archived, after.ids.includes(dropped)], [300, next, 1, false]);
    assert.deepEqual(after.ids.slice(0, -1), full.filter((x) => x !== dropped), "only the oldest ended one left the list, in order");
  });
}
