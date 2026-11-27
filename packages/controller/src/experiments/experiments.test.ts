import assert from "node:assert/strict";
import { after, test } from "node:test";
import { derivedId } from "../domain/ids.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { EnvironmentService } from "../environments/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { ExperimentService, betterPct, judge, sealOf, type Criteria, type ExperimentBody, type ExperimentOptions } from "./index.js";

// Card B04: bounded baseline experiments. Pinned criteria the candidate cannot move, runs that must report exactly the pinned metrics and cases, a verdict the controller reaches, results kept whichever way they
// come out, a budget that pauses, savings counted once. Real storage on each backend; the only clock is the test's, and nothing sleeps.

after(stopServer);

let now = Date.parse("2026-11-22T10:05:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const hex = (c: string): string => c.repeat(64);

const PROPOSAL = { problem: "reviews send back handlers without error tests", affectedWork: "request handler reviews", change: "add a checklist to the coder prompt", effort: "one afternoon", runningCost: "no extra tokens", benefit: "less rework", evaluation: "run the same five handler tasks with and without it", stoppingCondition: "five runs or the budget, whichever comes first" };
const criteria = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  baseline: { label: "prompt v4", ref: "commit abc123", digest: hex("a") }, evaluator: { label: "review rubric", ref: "rubric 2", digest: hex("b") },
  cases: [{ id: "c1", text: "handler with a missing field" }, { id: "c2", text: "handler with a slow dependency" }], baselinePassing: ["c1"],
  baselineMetrics: { timeToAcceptedSeconds: 100, reworkCount: 4, costPerSuccess: 10, adoptionCount: 5 }, budget: { maxRuns: 3, maxCost: 30 }, minRuns: 2, minImprovementPct: 5, maxRegressionPct: 0, ...over,
});
const good = { timeToAcceptedSeconds: 80, reworkCount: 3, costPerSuccess: 9, adoptionCount: 6 };
// Every agent has environment revision 1 (made by the owner) with one protected extension; a run names the reporter's own revision and the digest the host found there. The owner may name any agent's.
const GUARD = `sha256:${hex("9")}`;
const envOf = (agentId = "agent:dev", over: Record<string, unknown> = {}): Record<string, unknown> => ({ agentId, revision: 1, observed: { "nimblenewt.guard": GUARD }, disposable: true, ...over });
const MANIFEST = { base: { name: "nimblenewt-base", version: "1.0.0", digest: `sha256:${hex("1")}` }, packages: [], skills: [], capabilities: ["desk.read"], configuration: { installation: 1 }, limits: { cpus: 1, memoryMb: 512, diskMb: 1024, processes: 64 }, protectedExtensions: [{ name: "nimblenewt.guard", digest: GUARD }] };
const runArgs = (over: Record<string, unknown> = {}, agentId = "agent:dev"): Record<string, unknown> => ({ environment: envOf(agentId), cost: 5, metrics: good, cases: [{ id: "c1", passed: true }, { id: "c2", passed: false }], ...over });

interface Ctx {
  owner: Principal; mgr: Principal; mgr2: Principal; dev: Principal; dev2: Principal; reader: Principal; eve: Principal;
  a: string; b: string; svc: ExperimentService; storage: ControllerStorage; epoch: number;
  make(o?: ExperimentOptions): ExperimentService;
  env: EnvironmentService; reserved: Map<string, string>; usable: Set<string>;
  /** A proposed experiment by `dev` (or `by`). */
  propose(extra?: Record<string, unknown>, by?: Principal): Promise<string>;
  rev(id: string): Promise<number>;
  /** A proposed and pinned experiment. */
  started(over?: Record<string, unknown>, extra?: Record<string, unknown>): Promise<string>;
  run(id: string, over?: Record<string, unknown>, by?: Principal): Promise<{ run: number; status: string }>;
  conclude(id: string, by?: Principal): Promise<{ verdict: string }>;
  body(id: string): Promise<ExperimentBody>;
  lesson(project: string): Promise<string>;
}

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-11-22T10:05:00.000Z");
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
        const runner = new CommandRunner(world.storage, epoch, options);
        const reserved = new Map<string, string>([["nimblenewt.guard", GUARD]]);
        const usable = new Set<string>();
        const env = EnvironmentService.withEpoch(world.storage, epoch, { ...options, reservedDigest: async (name) => reserved.get(name), skillUsable: async (by, v) => usable.has(v) || usable.has(`${by.id}|${v}`) });
        const make = (o: ExperimentOptions = {}) => ExperimentService.withEpoch(world.storage, epoch, { ...options, environments: env, ...o });
        const svc = make();
        const mgr = await enroll("mgr", [{ action: "meeting.manage", project: a }]);
        const dev = await enroll("dev", [{ action: "meeting.agenda", project: a }]);
        const rest = { mgr2: await enroll("mgr2", [{ action: "meeting.manage", project: a }]), dev2: await enroll("dev2", [{ action: "meeting.agenda", project: a }]),
          reader: await enroll("reader", [{ action: "meeting.read", project: a }]), eve: await enroll("eve", [{ action: "meeting.manage", project: b }, { action: "meeting.agenda", project: b }]) };
        for (const p of [mgr, dev, ...Object.values(rest)]) await env.change(owner, { commandId: cid("env"), agentId: p.id, manifest: MANIFEST, reason: "first" });
        const ctx: Ctx = {
          owner, mgr, dev, ...rest,
          a, b, svc, storage: world.storage, epoch, make, env, reserved, usable,
          propose: async (extra = {}, by = dev) => (await svc.propose(by, { commandId: cid("x"), projectId: a, title: "Checklist prompt", proposal: PROPOSAL, affectedKey: "handler reviews", ...extra } as never)).id,
          rev: async (id) => (await svc.get(owner, id))!.revision,
          started: async (over = {}, extra = {}) => { const id = await ctx.propose(extra); await svc.pin(mgr, { commandId: cid("p"), experimentId: id, expectedRevision: await ctx.rev(id), criteria: criteria(over) } as never); return id; },
          run: async (id, over = {}, by = dev) => svc.recordRun(by, { commandId: cid("r"), experimentId: id, ...runArgs(over, by.kind === "owner" ? "agent:dev" : by.id) } as never),
          conclude: async (id, by = mgr) => svc.conclude(by, { commandId: cid("c"), experimentId: id, expectedRevision: await ctx.rev(id), finding: "read the runs" }),
          body: async (id) => (await svc.get(owner, id))! as unknown as ExperimentBody,
          lesson: async (project) => { const id = derivedId("lsn", cid("l")); await runner.command("test.put", { commandId: cid("put"), actor: owner.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "lesson", id }, creates: true, changes: [{ type: "create" as const, ref: { kind: "lesson", id }, body: { projectId: project, proposedBy: "agent:dev" } as never }], detail: {} }) })); return id; },
        };
        await body(ctx);
      } finally { await world.close(); }
    });

  suite("a proposal states the eight things, is scoped, replays, and does nothing until criteria are pinned", async (c) => {
    const id = await c.propose({}, c.dev);
    const again = await c.make().propose(c.dev, { commandId: "same-1", projectId: c.a, title: "T", proposal: PROPOSAL, affectedKey: "Handler Reviews" } as never);
    const twice = await c.make().propose(c.dev, { commandId: "same-1", projectId: c.a, title: "T", proposal: PROPOSAL, affectedKey: "Handler Reviews" } as never);
    assert.deepEqual([twice.id, twice.replayed, again.replayed], [again.id, true, false]);
    const got = await c.body(id);
    assert.deepEqual([got.status, got.proposedBy, got.runs.length, got.criteria, got.proposal.stoppingCondition], ["proposed", "agent:dev", 0, undefined, PROPOSAL.stoppingCondition]);
    assert.equal((await c.body(again.id)).affectedKey, "handler reviews");
    for (const f of Object.keys(PROPOSAL)) await refuses("invalid_command", () => c.svc.propose(c.dev, { commandId: cid("x"), projectId: c.a, title: "T", proposal: { ...PROPOSAL, [f]: undefined }, affectedKey: "k" } as never), new RegExp(`proposal.${f}`));
    await refuses("invalid_command", () => c.svc.propose(c.dev, { commandId: cid("x"), projectId: c.a, title: "T", proposal: { ...PROPOSAL, change: "use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }, affectedKey: "k" } as never), /credential/);
    await refuses("invalid_command", () => c.svc.propose(c.dev, { commandId: cid("x"), projectId: c.a, title: "T", proposal: { ...PROPOSAL, extra: "x" }, affectedKey: "k" } as never));
    await refuses("forbidden", () => c.svc.propose(c.eve, { commandId: cid("x"), projectId: c.a, title: "T", proposal: PROPOSAL, affectedKey: "k" } as never));
    await refuses("forbidden", () => c.svc.propose(c.reader, { commandId: cid("x"), projectId: c.a, title: "T", proposal: PROPOSAL, affectedKey: "k" } as never));
    // A lesson it tests must be of this project and readable.
    assert.equal((await c.body(await c.propose({ lessonId: await c.lesson(c.a) }))).lessonId !== undefined, true);
    await refuses("invalid_command", () => c.propose({ lessonId: "lsn-aaaaaaaaaaaaaaaaaaaa" }), /lessonId/);
    await refuses("invalid_command", async () => c.propose({ lessonId: await c.lesson(c.b) }), /lessonId/);
    // Reads: owner, reader, manager and proposer; a manager of another project and another proposer see nothing.
    for (const p of [c.owner, c.reader, c.mgr, c.dev]) assert.ok(await c.svc.get(p, id), p.id);
    for (const p of [c.eve, c.dev2]) assert.equal(await c.svc.get(p, id), undefined, p.id);
    assert.equal(await c.svc.get(c.owner, "exp-zzzzzzzzzzzzzzzzzzzz"), undefined);
    assert.equal(await c.svc.list(c.eve, c.a), undefined);
    assert.equal((await c.svc.list(c.reader, c.a))!.items.length, 3);
    // Runs are refused before the criteria are pinned.
    await refuses("invalid_command", () => c.run(id), /is proposed/);
  });

  suite("only a judge who is not the proposer pins the criteria, once; the seal is checked, and a stored change is caught", async (c) => {
    const id = await c.propose({}, c.dev);
    const pin = (by: Principal, over: Record<string, unknown> = {}, expected?: number) => c.svc.pin(by, { commandId: cid("p"), experimentId: id, expectedRevision: expected ?? 1, criteria: criteria(over) } as never);
    await refuses("forbidden", () => pin(c.dev), /proposer cannot set its own criteria/);
    await refuses("forbidden", () => pin(c.dev2));
    await refuses("forbidden", () => pin(c.reader));
    await refuses("forbidden", () => pin(c.eve));
    // A manager who proposed an experiment cannot pin its criteria either.
    const mine = await c.propose({}, c.mgr);
    await refuses("forbidden", () => c.svc.pin(c.mgr, { commandId: cid("p"), experimentId: mine, expectedRevision: 1, criteria: criteria() } as never));
    await refuses("stale_revision", () => pin(c.mgr, {}, 7));
    for (const [what, over, match] of [
      ["a digest that is not a hash", { baseline: { label: "x", ref: "y", digest: "abc" } }, /baseline.digest/],
      ["no cases", { cases: [] }, /cases/], ["duplicate cases", { cases: [{ id: "c1", text: "a" }, { id: "c1", text: "b" }] }, /different/],
      ["a baseline-passing case that is not pinned", { baselinePassing: ["zz"] }, /baselinePassing/], ["no baseline numbers", { baselineMetrics: {} }, /at least one/],
      ["an unknown metric", { baselineMetrics: { luck: 1 } }, /not a field/], ["a negative number", { baselineMetrics: { reworkCount: -1 } }, /number/],
      ["no budget", { budget: undefined }, /budget/], ["minRuns above the budget", { minRuns: 9 }, /minRuns/], ["an unknown key", { extra: 1 }, /./],
    ] as const) await refuses("invalid_command", () => pin(c.mgr, over as never), match);
    assert.equal((await c.body(id)).status, "proposed", "nothing refused changed it");
    const pinned = await pin(c.mgr);
    assert.match(pinned.seal, /^[0-9a-f]{64}$/);
    const got = await c.body(id);
    assert.deepEqual([got.status, got.pinnedBy, got.criteriaDigest === pinned.seal, got.criteria!.baselinePassing, got.criteria!.minRuns], ["running", "agent:mgr", true, ["c1"], 2]);
    await refuses("invalid_command", async () => c.svc.pin(c.mgr2, { commandId: cid("p"), experimentId: id, expectedRevision: await c.rev(id), criteria: criteria({ budget: { maxRuns: 50, maxCost: 1e6 } }) } as never), /pinned once/);
    // The owner may pin; the criteria of another experiment are its own.
    const other = await c.propose({}, c.dev);
    assert.ok((await c.svc.pin(c.owner, { commandId: cid("p"), experimentId: other, expectedRevision: 1, criteria: criteria() } as never)).seal);
    // The seal is checked on a run and at the end: criteria changed in storage (not through the service) are refused, not trusted.
    const runner = new CommandRunner(c.storage, c.epoch, options);
    const tamper = async (target: string): Promise<void> => {
      const found = (await runner.get("experiment", target))!;
      const b = found.body as unknown as ExperimentBody;
      await runner.command("test.tamper", { commandId: cid("t"), actor: c.owner.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "experiment", id: target }, creates: false, changes: [{ type: "update" as const, ref: { kind: "experiment", id: target }, expectedRevision: found.revision, body: { ...b, criteria: { ...b.criteria!, baselineMetrics: { ...b.criteria!.baselineMetrics, timeToAcceptedSeconds: 1000 } } } as never }], detail: {} }) }));
    };
    await tamper(id);
    await refuses("integrity", () => c.run(id), /seal/);
    await refuses("integrity", () => c.conclude(id), /seal/);
    // A budget raise renews the seal, so it must check the old one first: changed criteria are refused, never re-sealed.
    await refuses("integrity", async () => c.svc.raiseBudget(c.mgr, { commandId: cid("b"), experimentId: id, expectedRevision: await c.rev(id), maxRuns: 10, maxCost: 100, reason: "more" }), /seal/);
    assert.notEqual(sealOf((await c.body(id)).criteria!), (await c.body(id)).criteriaDigest, "the changed criteria were not re-sealed");
  });

  suite("a run must name a disposable environment and report exactly the pinned metrics and cases; only the proposer or a judge reports", async (c) => {
    const id = await c.started({ budget: { maxRuns: 10, maxCost: 100 } });
    await refuses("invalid_command", () => c.run(id, { environment: envOf("agent:dev", { disposable: false }) }), /disposable/);
    await refuses("invalid_command", () => c.run(id, { environment: envOf("agent:dev", { disposable: undefined }) }), /disposable/);
    await refuses("invalid_command", () => c.run(id, { environment: { ...envOf(), ref: "env-1" } }), /ref/);
    await refuses("invalid_command", () => c.run(id, { environment: undefined }), /environment/);
    await refuses("invalid_command", () => c.run(id, { metrics: { ...good, adoptionCount: undefined } }), /exactly the pinned metrics/);
    await refuses("invalid_command", () => c.run(id, { metrics: { ...good, maintenanceMinutes: 1 } }), /exactly the pinned metrics/);
    await refuses("invalid_command", () => c.run(id, { metrics: { ...good, reworkCount: "0" } }), /number/);
    await refuses("invalid_command", () => c.run(id, { cases: [{ id: "c1", passed: true }] }), /exactly the pinned evaluation cases/);
    await refuses("invalid_command", () => c.run(id, { cases: [{ id: "c1", passed: true }, { id: "c2", passed: true }, { id: "c3", passed: true }] }), /exactly the pinned evaluation cases/);
    await refuses("invalid_command", () => c.run(id, { cases: [{ id: "c1", passed: true }, { id: "c1", passed: true }] }), /exactly the pinned evaluation cases/);
    await refuses("invalid_command", () => c.run(id, { cost: -1 }), /cost/);
    await refuses("forbidden", () => c.run(id, {}, c.dev2));
    await refuses("forbidden", () => c.run(id, {}, c.reader));
    await refuses("forbidden", () => c.run(id, {}, c.eve));
    assert.equal((await c.body(id)).runs.length, 0, "nothing refused was kept");
    assert.deepEqual(await c.run(id, { note: "first" }), { run: 1, status: "running" });
    assert.deepEqual(await c.run(id, {}, c.mgr2), { run: 2, status: "running" });
    const got = await c.body(id);
    assert.deepEqual([got.runs.map((r) => [r.n, r.by, r.environment, r.cost]), got.spent, got.runs[0]!.note], [[[1, "agent:dev", "agent:dev revision 1", 5], [2, "agent:mgr2", "agent:mgr2 revision 1", 5]], { runs: 2, cost: 10 }, "first"]);
    // The same command again is the same run.
    const r = { commandId: "run-x", experimentId: id, ...runArgs() } as never;
    const first = await c.svc.recordRun(c.dev, r);
    const second = await c.make().recordRun(c.dev, r);
    assert.deepEqual([first.run, second.run, (await c.body(id)).runs.length], [3, 3, 3]);
    // After a later run, the replay still answers with its own run, not the newest.
    assert.deepEqual(await c.run(id, {}, c.mgr), { run: 4, status: "running" });
    assert.deepEqual(await c.make().recordRun(c.dev, r), { run: 3, status: "running" });
    assert.equal((await c.body(id)).runs.length, 4);
  });

  suite("slice 2: a run is kept only when the A08 revision its disposable environment was built from passes A08's check; the reporter names its own (the owner any); a replay is answered from its record", async (c) => {
    const id = await c.started({ budget: { maxRuns: 20, maxCost: 1000 } });
    const before = await c.rev(id);
    const withEnv = (env: Record<string, unknown>) => ({ environment: env });
    // Shapes, bounded before anything is stored.
    for (const bad of [{ ...envOf(), agentId: 7 }, { ...envOf(), agentId: "x".repeat(61) }, { ...envOf(), revision: 0 }, { ...envOf(), revision: 1.5 }, { ...envOf(), revision: "1" }, { ...envOf(), observed: [] }, { ...envOf(), observed: null }, { ...envOf(), observed: undefined },
      { ...envOf(), observed: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`ext-${i}`, GUARD])) }, { ...envOf(), observed: { "nimblenewt.guard": 5 } }, { ...envOf(), observed: { ["x".repeat(81)]: GUARD } }]) {
      await refuses("invalid_command", () => c.run(id, withEnv(bad)), /environment/);
    }
    await refuses("invalid_command", () => c.run(id, withEnv(envOf("dev"))), /agentId/);
    // The shape is judged before anything is stored or any right is looked up: a malformed reference from someone who may not report runs is refused for its shape.
    for (const agentId of [7, "x".repeat(61), ["agent:dev"]]) await refuses("invalid_command", () => c.run(id, withEnv(envOf("agent:dev", { agentId })), c.dev2), /environment\.agentId/);
    await refuses("forbidden", () => c.run(id, {}, c.dev2));
    // Rights come before any revision is looked up: someone who may not report runs is refused as forbidden whatever well-formed revision it names (another agent's, or one that does not exist).
    for (const env of [envOf("agent:dev"), envOf("agent:dev", { revision: 9 }), envOf("agent:dev2", { revision: 9 }), envOf("agent:dev2", { observed: {} })]) await refuses("forbidden", () => c.run(id, withEnv(env), c.dev2));
    // A08's own bounds: revision 500 and 20 observed extensions are shapes it accepts, then judged as usual.
    await refuses("not_found", () => c.run(id, withEnv(envOf("agent:dev", { revision: 500 }))), /revision 500 of agent:dev/);
    await refuses("integrity", () => c.run(id, withEnv(envOf("agent:dev", { observed: Object.fromEntries([["nimblenewt.guard", GUARD], ...Array.from({ length: 19 }, (_, i) => [`nimblenewt.e${i}`, GUARD])]) }))), /nimblenewt.e18 is loaded but the manifest does not name it/);
    // Only the owner (or the maintenance service) and the agent itself may name an agent's revisions: a service, a host or a client principal may not.
    for (const kind of ["service", "host", "client"]) await refuses("not_found", () => c.env.verify({ id: `${kind}:x`, kind, name: "x", grants: [] } as unknown as Principal, { agentId: "agent:dev", revision: 1, observed: { "nimblenewt.guard": GUARD } }), /may not name/);
    await refuses("invalid_command", () => c.run(id, withEnv(envOf("agent:dev", { revision: 501 }))), /revision/);
    await refuses("invalid_command", () => c.run(id, withEnv(envOf("agent:dev", { observed: { "nimblenewt.guard": "sha256:short" } }))), /digest/);
    await refuses("invalid_command", () => c.run(id, withEnv(envOf("agent:dev", { observed: JSON.parse(`{"__proto__":"${GUARD}"}`) }))), /observed/);
    // More shapes: disposable must be the value true; revisions that are not whole numbers from 1; agent names with control, format or capital characters; digests in another case or form; deep
    // nesting; a very large map. Each is refused for its own field, and from someone who may not report runs too (the shape comes before any right).
    for (const disposable of ["true", 1, {}]) await refuses("invalid_command", () => c.run(id, withEnv(envOf("agent:dev", { disposable }))), /disposable/);
    const deep = JSON.parse(`${"{\"a\":".repeat(2000)}1${"}".repeat(2000)}`);
    const shapes: [Record<string, unknown>, RegExp][] = [
      ...[Number.NaN, -1, Infinity, 1e300, 2 ** 53].map((revision): [Record<string, unknown>, RegExp] => [{ revision }, /environment\.revision/]),
      ...["agent:dev\u0000", "agent:​dev", "agent:Dev", " agent:dev", "agent:dev\n", `agent:${"d".repeat(41)}`].map((agentId): [Record<string, unknown>, RegExp] => [{ agentId }, /environment\.agentId/]),
      ...[`sha256:${"A".repeat(64)}`, `SHA256:${hex("9")}`, ` ${GUARD}`, `${GUARD}\u0000`, `sha256:${hex("9")}0`, { deep }].map((digest): [Record<string, unknown>, RegExp] => [{ observed: { "nimblenewt.guard": digest } }, /environment\.observed/]),
      [{ observed: { "nimblenewt.‮guard": GUARD } }, /environment\.observed/], [{ observed: deep }, /environment\.observed/],
      [{ observed: Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`nimblenewt.e${i}`, GUARD])) }, /environment\.observed/],
    ];
    for (const [over, match] of shapes) for (const by of [c.dev, c.dev2]) await refuses("invalid_command", () => c.svc.recordRun(by, { commandId: cid("r"), experimentId: id, ...runArgs(), environment: envOf("agent:dev", over) } as never), match);
    for (const by of [c.dev2, c.eve]) await refuses("invalid_command", () => c.svc.recordRun(by, { commandId: cid("r"), experimentId: id, ...runArgs(), environment: envOf("agent:dev", { revision: 501 }) } as never), /environment\.revision/);
    // A revision that does not exist, and another agent's revision, answer alike.
    await refuses("not_found", () => c.run(id, withEnv(envOf("agent:dev", { revision: 9 }))), /may not name environment revision 9 of agent:dev, or it does not exist/);
    await refuses("not_found", () => c.run(id, withEnv(envOf("agent:mgr"))), /may not name environment revision 1 of agent:mgr, or it does not exist/);
    await refuses("not_found", () => c.run(id, withEnv(envOf("agent:dev")), c.mgr), /may not name/);
    // A08's integrity check: the extension missing, another one on disk, one loaded that the manifest does not name, the catalog's digest moved, a skill revoked, the manifest changed in storage.
    await refuses("integrity", () => c.run(id, withEnv(envOf("agent:dev", { observed: {} }))), /nimblenewt.guard was not found where the worker loads it/);
    await assert.rejects(() => c.run(id, withEnv(envOf("agent:dev", { observed: {} }))), (e: unknown) => { assert.equal((e as DomainError).field, "environment"); return true; });
    await refuses("integrity", () => c.run(id, withEnv(envOf("agent:dev", { observed: { "nimblenewt.guard": `sha256:${hex("8")}` } }))), /on disk is not the one the manifest names/);
    await refuses("integrity", () => c.run(id, withEnv(envOf("agent:dev", { observed: { "nimblenewt.guard": GUARD, constructor: GUARD } }))), /constructor is loaded but the manifest does not name it/);
    c.reserved.set("nimblenewt.guard", `sha256:${hex("7")}`);
    await refuses("integrity", () => c.run(id), /the manifest's digest is not the catalog's/);
    c.reserved.delete("nimblenewt.guard");
    await refuses("integrity", () => c.run(id), /not a live system version/);
    // A refusal names every problem, not only the first.
    await refuses("integrity", () => c.run(id, withEnv(envOf("agent:dev", { observed: {} }))), /not a live system version in the catalog; nimblenewt.guard was not found where the worker loads it/);
    c.reserved.set("nimblenewt.guard", GUARD);
    const skill = "cav-aaaaaaaaaaaaaaaaaaaa";
    c.usable.add(skill);
    assert.deepEqual(await c.env.change(c.owner, { commandId: cid("env"), agentId: "agent:dev", manifest: { ...MANIFEST, skills: [skill] }, reason: "a skill", expectedRevision: 1 }), { revision: 2 });
    c.usable.delete(skill);
    await refuses("integrity", () => c.run(id, withEnv(envOf("agent:dev", { revision: 2 }))), /skill library is missing or was revoked/);
    // Skills are judged as usable by the reporter: one the owner may use but the reporter may not still refuses the reporter; once the reporter may use it, the revision passes.
    const rev2 = { agentId: "agent:dev", revision: 2, observed: { "nimblenewt.guard": GUARD } };
    c.usable.add(`${c.owner.id}|${skill}`);
    assert.equal((await c.env.verify(c.owner, rev2)).revision, 2);
    await refuses("integrity", () => c.env.verify(c.dev, rev2), /skill library/);
    c.usable.add(`agent:dev|${skill}`);
    assert.equal((await c.env.verify(c.dev, rev2)).revision, 2);
    c.usable.delete(`${c.owner.id}|${skill}`); c.usable.delete(`agent:dev|${skill}`);
    const runner = new CommandRunner(c.storage, c.epoch, options);
    const revRef = { kind: "environment-revision", id: derivedId("evr", "agent:dev2|1") };
    const stored = (await runner.get(revRef.kind, revRef.id))!;
    await runner.command("test.tamper", { commandId: cid("t"), actor: c.owner.id }, async () => ({ payload: {}, build: async () => ({ ref: revRef, creates: false, changes: [{ type: "update" as const, ref: revRef, expectedRevision: stored.revision, body: { ...(stored.body as object), manifest: { ...MANIFEST, capabilities: ["*"] } } as never }], detail: {} }) }));
    const pinned2 = await c.started({ budget: { maxRuns: 5, maxCost: 100 } }, {});
    await refuses("integrity", () => c.svc.recordRun(c.owner, { commandId: cid("r"), experimentId: pinned2, ...runArgs({}, "agent:dev2") } as never), /no longer matches its digest/);
    // Nothing refused was kept.
    assert.deepEqual([await c.rev(id), (await c.body(id)).runs.length, (await c.body(pinned2)).runs.length], [before, 0, 0]);
    // Without the environment records no run is recorded at all.
    await refuses("unavailable", () => c.make({ environments: undefined } as never).recordRun(c.dev, { commandId: cid("r"), experimentId: id, ...runArgs() } as never), /environment records are not available/);
    // That refusal comes before any right or state is read, so it is the same for someone who may not report runs.
    await refuses("unavailable", () => c.make({ environments: undefined } as never).recordRun(c.dev2, { commandId: cid("r"), experimentId: id, ...runArgs({}, "agent:dev2") } as never), /environment records are not available/);
    // A run that passes keeps the revision as the controller found it; the owner may name any agent's revision.
    const digest = (await c.env.get(c.owner, "agent:dev", 1))!.revision!.digest;
    const cmd = { commandId: "run-env", experimentId: id, ...runArgs() } as never;
    assert.deepEqual(await c.svc.recordRun(c.dev, cmd), { run: 1, status: "running" });
    assert.deepEqual(await c.svc.recordRun(c.owner, { commandId: cid("r"), experimentId: id, ...runArgs({}, "agent:mgr2") } as never), { run: 2, status: "running" });
    const got = await c.body(id);
    assert.deepEqual(got.runs.map((r) => [r.by, r.environment, r.environmentRevision]), [["agent:dev", "agent:dev revision 1", { agentId: "agent:dev", revision: 1, digest }], [c.owner.id, "agent:mgr2 revision 1", { agentId: "agent:mgr2", revision: 1, digest: (await c.env.get(c.owner, "agent:mgr2", 1))!.revision!.digest }]]);
    // The check is inside the command: a replay after the catalog moved is answered from its record; a new run is refused.
    c.reserved.set("nimblenewt.guard", `sha256:${hex("6")}`);
    assert.deepEqual(await c.make().recordRun(c.dev, cmd), { run: 1, status: "running" });
    await refuses("integrity", () => c.run(id), /catalog/);
    // The same command ID with another environment is a different command, refused.
    c.reserved.set("nimblenewt.guard", GUARD);
    await refuses("command_conflict", () => c.svc.recordRun(c.dev, { commandId: "run-env", experimentId: id, ...runArgs({}, "agent:dev"), environment: envOf("agent:dev", { revision: 2 }) } as never));
    assert.equal((await c.body(id)).runs.length, 2);
    // The payload is canonical: the same observed digests in another key order are the same command (a replay), and other digests under the same command ID are a conflict.
    const AUDIT = `sha256:${hex("5")}`;
    c.reserved.set("nimblenewt.audit", AUDIT);
    assert.deepEqual(await c.env.change(c.owner, { commandId: cid("env"), agentId: "agent:dev", manifest: { ...MANIFEST, protectedExtensions: [{ name: "nimblenewt.guard", digest: GUARD }, { name: "nimblenewt.audit", digest: AUDIT }] }, reason: "two", expectedRevision: 2 }), { revision: 3 });
    const two = (observed: Record<string, string>) => ({ commandId: "run-two", experimentId: id, ...runArgs(), environment: envOf("agent:dev", { revision: 3, observed }) }) as never;
    assert.deepEqual(await c.svc.recordRun(c.dev, two({ "nimblenewt.guard": GUARD, "nimblenewt.audit": AUDIT })), { run: 3, status: "running" });
    assert.deepEqual(await c.make().recordRun(c.dev, two({ "nimblenewt.audit": AUDIT, "nimblenewt.guard": GUARD })), { run: 3, status: "running" });
    await refuses("command_conflict", () => c.svc.recordRun(c.dev, two({ "nimblenewt.audit": AUDIT, "nimblenewt.guard": `sha256:${hex("4")}` })));
    const kept = await c.body(id);
    assert.deepEqual([kept.runs.length, kept.runs[2]!.environmentRevision?.revision, Object.keys(kept.runs[2]!).includes("observed")], [3, 3, false], "a run keeps the revision and its digest, never the observed list");
  });

  suite("the verdict is the controller's: improved, no-change, worse (a metric or a case the baseline passed) or inconclusive, and every result is kept", async (c) => {
    // improved
    const up = await c.started();
    await c.run(up); await c.run(up);
    assert.equal((await c.conclude(up)).verdict, "improved");
    const upBody = await c.body(up);
    assert.deepEqual([upBody.status, upBody.result!.verdict, upBody.result!.runsUsed, upBody.result!.betterPct, upBody.result!.failedCases, upBody.result!.by],
      ["concluded", "improved", 2, { timeToAcceptedSeconds: 20, reworkCount: 25, costPerSuccess: 10, adoptionCount: 20 }, [], "agent:mgr"]);
    assert.deepEqual(upBody.result!.savings.map((s) => [s.metric, s.amount, s.counted]), [["timeToAcceptedSeconds", 20, true], ["reworkCount", 1, true], ["costPerSuccess", 1, true]], "adoption is a gain, not a saving");
    // worse: a metric regressed
    const slow = await c.started();
    await c.run(slow, { metrics: { ...good, timeToAcceptedSeconds: 130 } }); await c.run(slow, { metrics: { ...good, timeToAcceptedSeconds: 130 } });
    assert.equal((await c.conclude(slow, c.mgr2)).verdict, "worse");
    // worse: a case the baseline passed failed once, though every metric is better
    const broke = await c.started();
    await c.run(broke); await c.run(broke, { cases: [{ id: "c1", passed: false }, { id: "c2", passed: true }] });
    assert.equal((await c.conclude(broke)).verdict, "worse");
    assert.deepEqual((await c.body(broke)).result!.failedCases, ["c1"]);
    // no change: inside the thresholds
    const flat = await c.started();
    const same = { timeToAcceptedSeconds: 100, reworkCount: 4, costPerSuccess: 10, adoptionCount: 5 };
    await c.run(flat, { metrics: same }); await c.run(flat, { metrics: { ...same, timeToAcceptedSeconds: 98 } });
    assert.equal((await c.conclude(flat)).verdict, "no-change");
    // inconclusive: fewer runs than pinned (minRuns 2)
    const few = await c.started();
    await c.run(few);
    assert.equal((await c.conclude(few)).verdict, "inconclusive");
    const none = await c.started();
    assert.equal((await c.conclude(none)).verdict, "inconclusive");
    assert.deepEqual((await c.body(none)).result!.candidateMetrics, {});
    // Negative results are saved and stay listed, with their runs, next to the good one.
    const listed = (await c.svc.list(c.reader, c.a, { status: "concluded" }))!.items;
    assert.deepEqual(listed.map((e) => [e.id, e.result!.verdict]), [[up, "improved"], [slow, "worse"], [broke, "worse"], [flat, "no-change"], [few, "inconclusive"], [none, "inconclusive"]]);
    assert.equal((await c.body(slow)).runs.length, 2);
    // A finding is required; the proposer and a stranger cannot conclude; a concluded one cannot be concluded again or take runs.
    const open = await c.started();
    await c.run(open);
    await refuses("invalid_command", () => c.svc.conclude(c.mgr, { commandId: cid("c"), experimentId: open, expectedRevision: 3, finding: undefined } as never), /finding/);
    await refuses("forbidden", () => c.conclude(open, c.dev), /cannot judge its own result/);
    await refuses("forbidden", () => c.conclude(open, c.eve));
    await refuses("forbidden", () => c.conclude(open, c.reader));
    await refuses("stale_revision", () => c.svc.conclude(c.mgr, { commandId: cid("c"), experimentId: open, expectedRevision: 1, finding: "x" }));
    // The same conclusion sent again (another controller) answers with the verdict it reached, not a default.
    const end = { commandId: cid("c"), experimentId: open, expectedRevision: await c.rev(open), finding: "read the runs" };
    const ended = await c.svc.conclude(c.mgr, end);
    assert.deepEqual(await c.make().conclude(c.mgr, end), ended);
    const better = await c.started();
    await c.run(better); await c.run(better);
    const once = { commandId: cid("c"), experimentId: better, expectedRevision: await c.rev(better), finding: "good" };
    assert.equal((await c.svc.conclude(c.mgr, once)).verdict, "improved");
    assert.equal((await c.make().conclude(c.mgr, once)).verdict, "improved", "a replay answers with the stored verdict");
    await refuses("invalid_command", () => c.conclude(open), /is concluded/);
    await refuses("invalid_command", () => c.run(open), /is concluded/);
  });

  suite("budget exhaustion pauses safely: the last run is kept, more are refused with nothing changed, only a raise or a conclusion moves it", async (c) => {
    const id = await c.started({ budget: { maxRuns: 2, maxCost: 100 }, minRuns: 1 });
    assert.deepEqual(await c.run(id), { run: 1, status: "running" });
    assert.deepEqual(await c.run(id), { run: 2, status: "paused" });
    let got = await c.body(id);
    assert.deepEqual([got.status, got.pausedWhy, got.runs.length, got.spent], ["paused", "budget", 2, { runs: 2, cost: 10 }]);
    const before = await c.rev(id);
    await refuses("unavailable", () => c.run(id), /budget .* is used up/);
    assert.equal(await c.rev(id), before, "the refused run changed nothing");
    // A raise must be a raise, by a judge, with a reason.
    const raise = (over: Record<string, unknown>, by: Principal = c.mgr2) => c.svc.raiseBudget(by, { commandId: cid("b"), experimentId: id, expectedRevision: before, maxRuns: 2, maxCost: 100, reason: "the trend looks real", ...over } as never);
    await refuses("invalid_command", () => raise({}), /only be raised/);
    await refuses("invalid_command", () => raise({ maxRuns: 1, maxCost: 500 }), /only be raised/);
    await refuses("invalid_command", () => raise({ maxRuns: 5, maxCost: 50 }), /only be raised/);
    await refuses("invalid_command", () => raise({ maxRuns: 3, reason: undefined }), /reason/);
    await refuses("forbidden", () => raise({ maxRuns: 3 }, c.dev), undefined);
    await refuses("forbidden", () => raise({ maxRuns: 3 }, c.eve));
    await raise({ maxRuns: 3 });
    got = await c.body(id);
    assert.deepEqual([got.status, got.pausedWhy, got.criteria!.budget, got.budgetRaises.map((r) => [r.by, r.maxRuns, r.reason]), got.criteriaDigest === sealOf(got.criteria!)], ["running", undefined, { maxRuns: 3, maxCost: 100 }, [["agent:mgr2", 3, "the trend looks real"]], true]);
    assert.deepEqual(await c.run(id), { run: 3, status: "paused" });
    // Cost alone also pauses: the run that crosses the line is kept.
    const dear = await c.started({ budget: { maxRuns: 10, maxCost: 12 }, minRuns: 1 });
    assert.deepEqual(await c.run(dear, { cost: 7 }), { run: 1, status: "running" });
    assert.deepEqual(await c.run(dear, { cost: 9 }), { run: 2, status: "paused" });
    assert.equal((await c.body(dear)).spent.cost, 16);
    // A raised budget that is still used up leaves it paused, and a paused experiment can simply be concluded: the runs it got are judged.
    await c.svc.raiseBudget(c.mgr, { commandId: cid("b"), experimentId: dear, expectedRevision: await c.rev(dear), maxRuns: 20, maxCost: 15, reason: "still too small" });
    assert.equal((await c.body(dear)).status, "paused");
    assert.equal((await c.conclude(dear)).verdict, "improved");
    await refuses("invalid_command", async () => c.svc.raiseBudget(c.mgr, { commandId: cid("b"), experimentId: dear, expectedRevision: await c.rev(dear), maxRuns: 30, maxCost: 99, reason: "x" } as never));
  });

  suite("a saving is counted once per metric and affected work; another work or another project counts again, and adoption is no saving", async (c) => {
    const first = await c.started({}, { affectedKey: "handler reviews" });
    const second = await c.started({}, { affectedKey: "Handler Reviews" });
    const third = await c.started({}, { affectedKey: "docs reviews" });
    const flat = await c.started({}, { affectedKey: "handler reviews" });
    for (const id of [first, second, third]) { await c.run(id); await c.run(id); }
    await c.run(flat, { metrics: { timeToAcceptedSeconds: 100, reworkCount: 4, costPerSuccess: 9, adoptionCount: 5 } }); await c.run(flat, { metrics: { timeToAcceptedSeconds: 100, reworkCount: 4, costPerSuccess: 9, adoptionCount: 5 } });
    await c.conclude(first);
    await c.conclude(second);
    await c.conclude(third);
    await c.conclude(flat);
    const sv = async (id: string) => (await c.body(id)).result!.savings.map((s) => [s.metric, s.counted, s.duplicateOf ?? null]);
    assert.deepEqual(await sv(first), [["timeToAcceptedSeconds", true, null], ["reworkCount", true, null], ["costPerSuccess", true, null]]);
    assert.deepEqual(await sv(second), [["timeToAcceptedSeconds", false, first], ["reworkCount", false, first], ["costPerSuccess", false, first]]);
    assert.deepEqual(await sv(third), [["timeToAcceptedSeconds", true, null], ["reworkCount", true, null], ["costPerSuccess", true, null]]);
    // Not improved (no metric reached the 5% bar except cost, 10%): its cost saving is a duplicate of the first.
    assert.equal((await c.body(flat)).result!.verdict, "improved");
    assert.deepEqual(await sv(flat), [["costPerSuccess", false, first]]);
    // A metric that improved under the pinned 5% bar is not claimed, so a later improvement that clears it on the same work still counts.
    const small = await c.started({}, { affectedKey: "ops reviews" });
    const later = await c.started({}, { affectedKey: "ops reviews" });
    for (let i = 0; i < 2; i++) { await c.run(small, { metrics: { ...good, costPerSuccess: 9.8 } }); await c.run(later); }
    await c.conclude(small);
    await c.conclude(later);
    assert.deepEqual(await sv(small), [["timeToAcceptedSeconds", true, null], ["reworkCount", true, null]], "2% on cost is under the bar");
    assert.deepEqual(await sv(later), [["timeToAcceptedSeconds", false, small], ["reworkCount", false, small], ["costPerSuccess", true, null]]);
    // A different project's claim is its own: the index is per project.
    assert.equal(await c.svc.list(c.eve, c.b).then((l) => l!.items.length), 0);
  });

  suite("withdrawing: only before it starts, by the proposer or a judge; it stays listed; paging and the status filter work; a restart reads the same", async (c) => {
    const x = await c.propose(); const y = await c.propose(); const z = await c.started();
    await refuses("forbidden", () => c.svc.withdraw(c.dev2, { commandId: cid("w"), experimentId: x, expectedRevision: 1, reason: "no" }));
    await refuses("forbidden", () => c.svc.withdraw(c.eve, { commandId: cid("w"), experimentId: x, expectedRevision: 1, reason: "no" }));
    await refuses("stale_revision", () => c.svc.withdraw(c.dev, { commandId: cid("w"), experimentId: x, expectedRevision: 5, reason: "no" }));
    await c.svc.withdraw(c.dev, { commandId: cid("w"), experimentId: x, expectedRevision: 1, reason: "changed my mind" });
    await c.svc.withdraw(c.mgr, { commandId: cid("w"), experimentId: y, expectedRevision: 1, reason: "not now" });
    await refuses("invalid_command", async () => c.svc.withdraw(c.dev, { commandId: cid("w"), experimentId: z, expectedRevision: await c.rev(z), reason: "stop" }), /not yet started/);
    await refuses("invalid_command", async () => c.svc.withdraw(c.dev, { commandId: cid("w"), experimentId: x, expectedRevision: await c.rev(x), reason: "again" }), /not yet started/);
    const view = c.make();
    const all = (await view.list(c.mgr, c.a))!;
    assert.deepEqual(all.items.map((e) => [e.id, e.status]), [[x, "withdrawn"], [y, "withdrawn"], [z, "running"]]);
    const page = (await view.list(c.mgr, c.a, { limit: 2 }))!;
    assert.deepEqual([page.items.length, page.next], [2, y]);
    assert.deepEqual((await view.list(c.mgr, c.a, { afterId: page.next! }))!.items.map((e) => e.id), [z]);
    assert.deepEqual((await view.list(c.mgr, c.a, { status: "running" }))!.items.map((e) => e.id), [z]);
    await refuses("invalid_command", () => view.list(c.mgr, c.a, { status: "bogus" }));
    await refuses("invalid_command", () => view.list(c.mgr, c.a, { afterId: "exp-zzzzzzzzzzzzzzzzzzzz" }));
    assert.deepEqual((await c.body(x)).history.map((h) => [h.to, h.cause ?? null]), [["proposed", null], ["withdrawn", "changed my mind"]]);
  });

  suite("two controllers reporting runs at once keep both runs; two concluding at once conclude once", async (c) => {
    const id = await c.started({ budget: { maxRuns: 10, maxCost: 1000 } });
    const other = c.make();
    const settled = await Promise.all([c.run(id), other.recordRun(c.dev, { commandId: cid("r"), experimentId: id, ...runArgs() } as never), c.run(id, {}, c.mgr)]);
    assert.deepEqual(settled.map((s) => s.run).sort(), [1, 2, 3]);
    const got = await c.body(id);
    assert.deepEqual([got.runs.map((r) => r.n), got.spent.runs], [[1, 2, 3], 3]);
    const rev = await c.rev(id);
    const outcomes = await Promise.allSettled([
      c.svc.conclude(c.mgr, { commandId: cid("c"), experimentId: id, expectedRevision: rev, finding: "one" }),
      other.conclude(c.mgr2, { commandId: cid("c"), experimentId: id, expectedRevision: rev, finding: "two" }),
    ]);
    assert.deepEqual(outcomes.map((o) => o.status).sort(), ["fulfilled", "rejected"]);
    assert.equal((await c.body(id)).status, "concluded");
    // Two improvements on the same work concluded at once by two controllers: each saving is counted exactly once between them.
    const p = await c.started({}, { affectedKey: "race" });
    const q = await c.started({}, { affectedKey: "race" });
    for (const e of [p, q]) { await c.run(e); await c.run(e); }
    const [rp, rq] = [await c.rev(p), await c.rev(q)];
    await Promise.all([c.svc.conclude(c.mgr, { commandId: cid("c"), experimentId: p, expectedRevision: rp, finding: "p" }), other.conclude(c.mgr2, { commandId: cid("c"), experimentId: q, expectedRevision: rq, finding: "q" })]);
    const both = [...(await c.body(p)).result!.savings, ...(await c.body(q)).result!.savings];
    for (const m of ["timeToAcceptedSeconds", "reworkCount", "costPerSuccess"]) assert.deepEqual(both.filter((s) => s.metric === m).map((s) => s.counted).sort(), [false, true], m);
    // Two controllers reporting the last run the budget allows at once: one is kept and pauses it, the other is refused, and the budget is not overrun.
    const edge = await c.started({ budget: { maxRuns: 2, maxCost: 1000 }, minRuns: 1 });
    await c.run(edge);
    const last = await Promise.allSettled([c.run(edge), other.recordRun(c.mgr, { commandId: cid("r"), experimentId: edge, ...runArgs({}, c.mgr.id) } as never)]);
    assert.deepEqual(last.map((o) => (o.status === "fulfilled" ? `${o.value.run} ${o.value.status}` : (o.reason as DomainError).code)).sort(), ["2 paused", "unavailable"]);
    assert.deepEqual([(await c.body(edge)).runs.length, (await c.body(edge)).spent.runs], [2, 2]);
  });

  suite("a task credential acts only in its own task's project", async (c) => {
    const id = await c.started({ budget: { maxRuns: 10, maxCost: 100 } });
    const elsewhere = (p: Principal): Principal => ({ ...p, taskScope: { taskId: "task-elsewhere", projectId: c.b } }) as Principal;
    const here = (p: Principal): Principal => ({ ...p, taskScope: { taskId: "task-here", projectId: c.a } }) as Principal;
    const before = await c.rev(id);
    await refuses("forbidden", () => c.run(id, {}, elsewhere(c.dev)));
    await refuses("forbidden", () => c.run(id, {}, elsewhere(c.mgr)));
    await refuses("forbidden", () => c.conclude(id, elsewhere(c.mgr)));
    await refuses("forbidden", () => c.svc.raiseBudget(elsewhere(c.mgr), { commandId: cid("b"), experimentId: id, expectedRevision: before, maxRuns: 20, maxCost: 100, reason: "more" }));
    await refuses("forbidden", () => c.svc.propose(elsewhere(c.dev), { commandId: cid("x"), projectId: c.a, title: "T", proposal: PROPOSAL, affectedKey: "k" } as never));
    const fresh = await c.propose();
    await refuses("forbidden", () => c.svc.pin(elsewhere(c.mgr), { commandId: cid("p"), experimentId: fresh, expectedRevision: 1, criteria: criteria() } as never));
    await refuses("forbidden", () => c.svc.withdraw(elsewhere(c.dev), { commandId: cid("w"), experimentId: fresh, expectedRevision: 1, reason: "no" }));
    assert.equal(await c.svc.get(elsewhere(c.dev), id), undefined);
    assert.equal(await c.svc.list(elsewhere(c.mgr), c.a), undefined);
    assert.equal(await c.rev(id), before, "nothing refused changed it");
    // In its own project the same agent acts as usual.
    assert.deepEqual(await c.run(id, {}, here(c.dev)), { run: 1, status: "running" });
    // A task credential is its agent: it names its own revision, and another agent's answers as one that does not exist.
    await refuses("not_found", () => c.svc.recordRun(here(c.dev), { commandId: cid("r"), experimentId: id, ...runArgs({}, "agent:mgr") } as never), /may not name environment revision 1 of agent:mgr/);
    assert.ok(await c.svc.get(here(c.dev), id));
  });
}

test("the verdict arithmetic: lower is better except adoption, a zero baseline moves by a hundred, thresholds decide, the proposer's words decide nothing", () => {
  assert.equal(betterPct("reworkCount", 4, 3), 25);
  assert.equal(betterPct("reworkCount", 4, 5), -25);
  assert.equal(betterPct("adoptionCount", 5, 6), 20);
  assert.equal(betterPct("adoptionCount", 5, 4), -20);
  assert.deepEqual([betterPct("reworkCount", 0, 0), betterPct("reworkCount", 0, 2), betterPct("adoptionCount", 0, 2)], [0, -100, 100]);
  const crit = criteria({ minRuns: 1 }) as never as Criteria;
  const run = (metrics: Record<string, number>, cases = [{ id: "c1", passed: true }, { id: "c2", passed: true }]) => ({ n: 1, at: "t", by: "a", environment: "agent:a revision 1", cost: 1, metrics, cases }) as never;
  assert.equal(judge(crit, [run({ ...good, timeToAcceptedSeconds: 96 })]).verdict, "improved", "4% time but 25% rework: any metric at the bar");
  assert.equal(judge(crit, [run({ timeToAcceptedSeconds: 97, reworkCount: 4, costPerSuccess: 10, adoptionCount: 5 })]).verdict, "no-change", "3% is under the 5% bar");
  const lenient = { ...crit, maxRegressionPct: 10 };
  assert.equal(judge(lenient, [run({ timeToAcceptedSeconds: 105, reworkCount: 3, costPerSuccess: 10, adoptionCount: 5 })]).verdict, "improved", "5% worse is inside the 10% allowance");
  assert.equal(judge(lenient, [run({ timeToAcceptedSeconds: 115, reworkCount: 3, costPerSuccess: 10, adoptionCount: 5 })]).verdict, "worse");
  assert.equal(judge({ ...crit, minImprovementPct: 0 }, [run({ timeToAcceptedSeconds: 100, reworkCount: 4, costPerSuccess: 10, adoptionCount: 5 })]).verdict, "no-change", "no change is not a gain at a zero bar");
  assert.equal(judge(crit, []).verdict, "inconclusive");
});
