import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CatalogService, versionIdOf } from "../catalog/index.js";
import { DeskService } from "../context/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { EnvironmentService } from "../environments/index.js";
import { ExperimentService } from "../experiments/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { StatusService } from "../status/index.js";
import type { ControllerStorage, OperationInput } from "../storage/types.js";
import { AdoptionService, type AdoptionCatalog } from "./index.js";

// Card B05, standing slice: future use of an adopted tool follows the catalog. A version set aside (deprecated, or rolled back past) is not adopted; a tool adoption approved earlier is not in force
// while the catalog no longer offers that exact version (revoked, set aside, gone, another digest), and is in force again when the owner returns to it; asking writes nothing. Withdrawal, by a decision
// or a regression, writes only the adoption and its index: recorded external effects (confirmed, failed, uncertain, intended) stay exactly as they were. Real storage on each backend; a fresh adoption
// service at every step (as after a restart); the only clock is the test's.

after(stopServer);

const now = Date.parse("2026-11-27T10:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
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

interface Ctx {
  owner: Principal; mgr: Principal; dev: Principal; reader: Principal; eve: Principal; maint: Principal;
  a: string; storage: ControllerStorage; epoch: number; cat: CatalogService; exps: ExperimentService;
  make(o?: { tools?: AdoptionCatalog | undefined; storage?: ControllerStorage }): AdoptionService;
  experiment(): Promise<string>;
  ask(experimentId: string, target?: Record<string, unknown>, by?: Principal): Promise<string>;
  rev(id: string): Promise<number>;
  approve(id: string, by?: Principal, svc?: AdoptionService): Promise<{ revision: number }>;
  inForce(target: Record<string, unknown>, by?: Principal, svc?: AdoptionService): Promise<string | undefined>;
  register(name: string, version: string): Promise<void>;
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
        const make = (o: { tools?: AdoptionCatalog | undefined; storage?: ControllerStorage } = {}) => AdoptionService.withEpoch(o.storage ?? world.storage, epoch, { ...options, ...("tools" in o ? (o.tools === undefined ? {} : { tools: o.tools }) : { tools: cat }) });
        const mgr = await enroll("mgr", [{ action: "meeting.manage", project: a }]);
        const dev = await enroll("dev", [{ action: "meeting.agenda", project: a }]);
        const reader = await enroll("reader", [{ action: "meeting.read", project: a }]);
        const eve = await enroll("eve", [{ action: "meeting.manage", project: b }, { action: "meeting.read", project: b }, { action: "catalog.read", project: "*" }]);
        const maint = await enroll("maint", [{ action: "meeting.manage", project: a }, { action: "toolbox.manage", project: "*" }, { action: "catalog.read", project: "*" }]);
        const author = await enroll("author", [{ action: "desk.write", project: a }, { action: "desk.read", project: a }]);
        await env.change(owner, { commandId: cid("env"), agentId: dev.id, manifest: MANIFEST, reason: "first" });
        const note = (await desks.write(author, { commandId: cid("w"), projectId: a, kind: "note", title: "fetch", body: "Use fetch to read a page.", visibility: "shared", status: "accepted" } as never)).id;
        const ctx: Ctx = {
          owner, mgr, dev, reader, eve, maint, a, storage: world.storage, epoch, cat, exps, make,
          register: async (nm, v) => { await cat.register(owner, { commandId: cid("r"), name: nm, kind: "skill", version: v, manifest: SKILL, instructionsRecordId: note } as never); },
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
          inForce: async (target, by = owner, svc = make()) => (await svc.inForce(by, { projectId: a, target }))?.adoptionId,
        };
        await body(ctx);
      } finally { await world.close(); }
    });

  suite("the catalog's standing of a version: revoked from the entry's list, set aside by deprecation or rollback, and undefined for anything not published", async (c) => {
    await c.register("toolbox.fetch", "1.0.0");
    await c.register("toolbox.fetch", "1.1.0");
    await c.register("toolbox.fetch", "1.2.0");
    const digest = (await c.cat.get(c.owner, "toolbox.fetch", "1.0.0"))!.digest;
    assert.deepEqual(await c.cat.standingOf("toolbox.fetch", "1.0.0"), { digest, revoked: false, setAside: false });
    await c.cat.revoke(c.owner, { commandId: cid("v"), name: "toolbox.fetch", version: "1.1.0", reason: "it broke pages" });
    await c.cat.deprecate(c.owner, { commandId: cid("d"), name: "toolbox.fetch", version: "1.2.0", reason: "slower" });
    assert.deepEqual([(await c.cat.standingOf("toolbox.fetch", "1.1.0"))?.revoked, (await c.cat.standingOf("toolbox.fetch", "1.1.0"))?.setAside], [true, false]);
    assert.deepEqual([(await c.cat.standingOf("toolbox.fetch", "1.2.0"))?.revoked, (await c.cat.standingOf("toolbox.fetch", "1.2.0"))?.setAside], [false, true]);
    for (const [nm, v] of [["toolbox.fetch", "2.0.0"], ["toolbox.none", "1.0.0"], ["Toolbox.Fetch", "1.0.0"], ["toolbox.fetch", "1.0"], ["toolbox.fetch", "1.0.0-rc.1"], ["toolbox.fetch", 1 as unknown as string], ["../x", "1.0.0"]] as const) {
      assert.equal(await c.cat.standingOf(nm, v), undefined, `${String(nm)} ${String(v)}`);
    }
  });

  suite("a set-aside version is not adopted; an approved tool is not in force while its version is set aside or revoked, is again when the owner rolls back to it, and asking writes nothing", async (c) => {
    for (const v of ["1.0.0", "1.2.0"]) await c.register("toolbox.fetch", v);
    await c.register("toolbox.grab", "1.0.0");
    await c.register("toolbox.roll", "1.0.0");
    await c.register("toolbox.roll", "2.0.0");
    // Deprecated, or rolled back past: refused at approval, and the request still waits.
    await c.cat.deprecate(c.owner, { commandId: cid("d"), name: "toolbox.fetch", version: "1.2.0", reason: "slower" });
    await c.cat.rollback(c.owner, { commandId: cid("rb"), name: "toolbox.roll", toVersion: "1.0.0", reason: "2.0.0 is worse" });
    const exp = await c.experiment();
    for (const [nm, v] of [["toolbox.fetch", "1.2.0"], ["toolbox.roll", "2.0.0"]] as const) {
      const id = await c.ask(exp, tool(nm, v), c.reader);
      await refuses("invalid_command", () => c.approve(id, c.maint), /set aside in the catalog/);
      await refuses("invalid_command", () => c.approve(id, c.owner), /set aside in the catalog/);
      assert.equal((await c.make().get(c.owner, id))!.status, "requested");
      await c.make().decline(c.owner, { commandId: cid("dc"), adoptionId: id, expectedRevision: await c.rev(id), reason: "set aside" });
    }
    // The version the rollback returned to is still chosen, so it is adopted.
    const roll = await c.ask(exp, tool("toolbox.roll", "1.0.0"));
    await c.approve(roll);
    assert.equal(await c.inForce(tool("toolbox.roll", "1.0.0")), roll);

    const fetch = await c.ask(exp, tool("toolbox.fetch"));
    await c.approve(fetch);
    const practice = await c.ask(exp, PRACTICE);
    await c.approve(practice, c.owner);
    assert.equal(await c.inForce(tool("toolbox.fetch")), fetch);
    assert.equal(await c.inForce(tool("toolbox.fetch"), c.reader), fetch);
    assert.equal(await c.make().standing(c.reader, fetch), "live");
    assert.equal(await c.make().standing(c.reader, practice), "live");
    // Set aside after approval: not in force, for every reader; the adoption itself is unchanged (still active, same revision) and is still monitored and withdrawn by its ID.
    const before = await c.rev(fetch);
    await c.cat.deprecate(c.owner, { commandId: cid("d"), name: "toolbox.fetch", version: "1.0.0", reason: "replaced" });
    assert.equal(await c.inForce(tool("toolbox.fetch")), undefined, "set aside: not in force");
    assert.equal(await c.inForce(tool("toolbox.fetch"), c.reader), undefined);
    assert.equal(await c.make().standing(c.owner, fetch), "set-aside");
    assert.deepEqual([(await c.make().get(c.owner, fetch))!.status, await c.rev(fetch)], ["active", before], "asking writes nothing");
    assert.equal((await c.make().inForce(c.owner, { projectId: c.a, experimentId: exp, target: PRACTICE }))?.adoptionId, practice, "a practice does not follow the catalog");
    // The owner returns to it (a rollback to that version takes it out of the set-aside list): in force again, the same adoption.
    await c.cat.rollback(c.owner, { commandId: cid("rb"), name: "toolbox.fetch", toVersion: "1.0.0", reason: "1.2.0 is worse" });
    assert.equal(await c.inForce(tool("toolbox.fetch")), fetch, "in force again");
    assert.equal(await c.make().standing(c.owner, fetch), "live");
    // Revoked after approval: not in force, for good; still withdrawn by a manager.
    const grab = await c.ask(exp, tool("toolbox.grab"), c.reader);
    await c.approve(grab);
    assert.equal(await c.inForce(tool("toolbox.grab")), grab);
    await c.cat.revoke(c.owner, { commandId: cid("v"), name: "toolbox.grab", version: "1.0.0", reason: "unsafe" });
    assert.equal(await c.inForce(tool("toolbox.grab")), undefined, "revoked: not in force");
    assert.equal(await c.make().standing(c.reader, grab), "revoked");
    const m = await c.make().monitor(c.dev, { commandId: cid("m"), adoptionId: fetch, metrics: GOOD });
    assert.equal(m.status, "active");
    await c.make().withdraw(c.mgr, { commandId: cid("w"), adoptionId: grab, expectedRevision: await c.rev(grab), reason: "revoked in the catalog" });
    assert.equal(await c.make().standing(c.owner, grab), undefined, "only an active adoption has a standing");
    // Readers only: another project's manager, an unknown or malformed ID, and an asked adoption all answer undefined.
    assert.equal(await c.make().standing(c.eve, fetch), undefined);
    assert.equal(await c.make().inForce(c.eve, { projectId: c.a, target: tool("toolbox.fetch") }), undefined);
    assert.equal(await c.make().standing(c.owner, `adp-${"a".repeat(20)}`), undefined);
    assert.equal(await c.make().standing(c.owner, "adp-1"), undefined);
    assert.equal(await c.make().standing(c.owner, await c.ask(exp, tool("toolbox.fetch", "1.2.0"), c.reader)), undefined);
  });

  suite("without a catalog, or with one that cannot vouch for the exact version, no tool is approved or answered as in force; any other error is passed on", async (c) => {
    await c.register("toolbox.fetch", "1.0.0");
    const real = (await c.cat.standingOf("toolbox.fetch", "1.0.0"))!;
    const exp = await c.experiment();
    const id = await c.ask(exp, tool("toolbox.fetch"));
    const fake = (standingOf: AdoptionCatalog["standingOf"]): AdoptionService => c.make({ tools: { get: (by, nm, v) => c.cat.get(by, nm, v), standingOf } });
    // At approval: the entry's list says revoked though the revocation record says nothing, the version is gone, another digest, a refusal, a throw.
    await refuses("invalid_command", () => c.approve(id, c.maint, fake(async () => ({ ...real, revoked: true }))), /revoked/);
    await refuses("invalid_command", () => c.approve(id, c.maint, fake(async () => ({ ...real, setAside: true }))), /set aside/);
    await refuses("not_found", () => c.approve(id, c.maint, fake(async () => undefined)), /not a published version/);
    await refuses("not_found", () => c.approve(id, c.maint, fake(async () => ({ ...real, digest: `sha256:${hex("f")}` }))), /not a published version/);
    await refuses("not_found", () => c.approve(id, c.maint, fake(async () => { throw new DomainError("forbidden", "no"); })));
    await assert.rejects(() => c.approve(id, c.maint, fake(async () => { throw new Error("disk gone"); })), /disk gone/);
    assert.deepEqual([(await c.make().get(c.owner, id))!.status, await c.rev(id)], ["requested", 1], "nothing was written");
    await c.approve(id);
    const digest = (await c.make().get(c.owner, id))!.targetDigest;
    assert.equal(digest, real.digest);
    // inForce: the real catalog says live; every doubt answers undefined.
    assert.equal(await c.inForce(tool("toolbox.fetch")), id);
    assert.equal(await c.inForce(tool("toolbox.fetch"), c.owner, c.make({ tools: undefined })), undefined, "no catalog: not in force");
    assert.equal(await c.make({ tools: undefined }).standing(c.owner, id), "unavailable");
    for (const [why, s] of [["gone", async () => undefined], ["another digest", async () => ({ ...real, digest: `sha256:${hex("f")}` })], ["revoked", async () => ({ ...real, revoked: true })], ["set aside", async () => ({ ...real, setAside: true })], ["refused", async () => { throw new DomainError("not_found", "no"); }]] as [string, AdoptionCatalog["standingOf"]][]) {
      assert.equal(await c.inForce(tool("toolbox.fetch"), c.owner, fake(s)), undefined, why);
    }
    await assert.rejects(() => c.inForce(tool("toolbox.fetch"), c.owner, fake(async () => { throw new Error("disk gone"); })), /disk gone/);
    assert.equal(await fake(async () => ({ ...real, digest: `sha256:${hex("f")}` })).standing(c.owner, id), "gone");
    // An adoption whose recorded digest is missing (a damaged record) is never in force, even though the catalog offers the version.
    const runner = new CommandRunner(c.storage, c.epoch, options);
    const stored = (await runner.get("adoption", id))!;
    const { targetDigest: _d, ...damaged } = stored.body as Record<string, unknown>;
    void _d;
    await runner.command("test.damage", { commandId: cid("t"), actor: c.owner.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "adoption", id }, creates: false, changes: [{ type: "update" as const, ref: { kind: "adoption", id }, expectedRevision: stored.revision, body: damaged as never }], detail: {} }) }));
    assert.equal(await c.inForce(tool("toolbox.fetch")), undefined, "no recorded digest: not in force");
    assert.equal(await c.make().standing(c.owner, id), "gone");
    // A practice does not consult the catalog at all.
    const practice = await c.ask(exp, PRACTICE);
    await c.approve(practice, c.owner, c.make({ tools: undefined }));
    assert.equal((await c.make({ tools: undefined }).inForce(c.owner, { projectId: c.a, experimentId: exp, target: PRACTICE }))?.adoptionId, practice, "a practice needs no catalog");
  });

  suite("first review: a damaged catalog entry fails toward stricter, independence is refused before where the version stands, and the status view says not in force when the standing cannot be read", async (c) => {
    await c.register("toolbox.fetch", "1.0.0");
    await c.register("toolbox.grab", "1.0.0");
    const runner = new CommandRunner(c.storage, c.epoch, options);
    const damage = async (name: string, over: Record<string, unknown>, ref = { kind: "catalog-entry", id: derivedId("cat", name) }): Promise<void> => {
      const stored = (await runner.get(ref.kind, ref.id))!;
      await runner.command("test.damage", { commandId: cid("t"), actor: c.owner.id }, async () => ({ payload: {}, build: async () => ({ ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: stored.revision, body: { ...(stored.body as Record<string, unknown>), ...over } as never }], detail: {} }) }));
    };
    const real = (await c.cat.standingOf("toolbox.fetch", "1.0.0"))!;
    // A `deprecated` that is not a list is set aside; a `revoked` that is not a list is revoked.
    await damage("toolbox.fetch", { deprecated: "1.0.0" });
    assert.deepEqual(await c.cat.standingOf("toolbox.fetch", "1.0.0"), { digest: real.digest, revoked: false, setAside: true });
    await damage("toolbox.fetch", { deprecated: { "1.0.0": true } });
    assert.equal((await c.cat.standingOf("toolbox.fetch", "1.0.0"))?.setAside, true);
    await damage("toolbox.fetch", { deprecated: [], revoked: null });
    assert.deepEqual(await c.cat.standingOf("toolbox.fetch", "1.0.0"), { digest: real.digest, revoked: true, setAside: false });
    await damage("toolbox.fetch", { revoked: [] });
    assert.deepEqual(await c.cat.standingOf("toolbox.fetch", "1.0.0"), { ...real });
    // The entry no longer lists the version (its record still there), or the version record names another version: neither is offered.
    await damage("toolbox.fetch", { versions: [] });
    assert.equal(await c.cat.standingOf("toolbox.fetch", "1.0.0"), undefined, "not in the entry's list");
    await damage("toolbox.fetch", { versions: ["1.0.0"] });
    assert.deepEqual(await c.cat.standingOf("toolbox.fetch", "1.0.0"), { ...real });
    const vref = { kind: "catalog-version", id: versionIdOf("toolbox.fetch", "1.0.0") };
    await damage("toolbox.fetch", { version: "9.9.9" }, vref);
    assert.equal(await c.cat.standingOf("toolbox.fetch", "1.0.0"), undefined, "the record is of another version");
    await damage("toolbox.fetch", { version: "1.0.0" }, vref);
    assert.deepEqual(await c.cat.standingOf("toolbox.fetch", "1.0.0"), { ...real });

    // A reviewer who registered the version is told it is not independent, whatever the version's standing (rights before state).
    const exp = await c.experiment();
    const id = await c.ask(exp, tool("toolbox.fetch"), c.reader);
    const mine = (s: Awaited<ReturnType<AdoptionCatalog["standingOf"]>>, revoked = false): AdoptionService => c.make({ tools: { get: async (by, nm, v) => { const g = (await c.cat.get(by, nm, v))!; return { ...g, registeredBy: c.maint.id, ...(revoked ? { revoked: { revokedBy: c.owner.id, reason: "x", at: g.createdAt } } : {}) } as never; }, standingOf: async () => s } });
    for (const [why, svc] of [["live", mine(real)], ["set aside", mine({ ...real, setAside: true })], ["revoked by list", mine({ ...real, revoked: true })], ["gone", mine(undefined)], ["revoked record", mine(real, true)]] as const) {
      await refuses("forbidden", () => c.approve(id, c.maint, svc), /not independent/);
      void why;
    }
    assert.equal(await c.rev(id), 1, "nothing was written");

    // The status view: an approved tool whose standing cannot be read is shown as not in force, and the rest of the view still answers.
    await c.approve(id);
    const practice = await c.ask(exp, PRACTICE);
    await c.approve(practice, c.owner);
    const view = (adoptions: Pick<AdoptionService, "list" | "standing">) => StatusService.withEpoch(c.storage, c.epoch, { assignments: {} as never, waits: {} as never, blockers: {} as never, contracts: {} as never, experiments: c.exps, adoptions }, options);
    const text = async (adoptions: Pick<AdoptionService, "list" | "standing">) => (await view(adoptions).ask(c.owner, { kind: "experiments", projectId: c.a }))!.lines.map((l) => l.text).join("\n");
    const svc = c.make();
    const tl = new RegExp(`Adoption of tool toolbox\\.fetch 1\\.0\\.0 from experiment ${exp}: `);
    assert.match(await text(svc), new RegExp(`${tl.source}in force, approved by agent:maint`));
    const failing = { list: svc.list.bind(svc), standing: async () => { throw new Error("store down"); } };
    const out = await text(failing);
    assert.match(out, new RegExp(`${tl.source}approved by agent:maint \\(grant: meeting\\.manage, toolbox\\.manage\\), but not in force now: its standing in the catalog cannot be read right now, so it is not used\\.`));
    assert.match(out, /Adoption of the practice it tried from experiment exp-[a-z2-7]+: in force, approved by owner:rob/, "the practice is still shown in force");
    const changed = await text({ list: svc.list.bind(svc), standing: async () => undefined });
    assert.match(changed, new RegExp(`${tl.source}approved by agent:maint .*, but not in force now: it changed while this view was read; ask again, so it is not used\\.`));
    assert.doesNotMatch(changed, new RegExp(`${tl.source}in force`));
  });

  suite("withdrawal, by a decision or a regression, and declining write only the adoption and its index: recorded external effects and the catalog stay exactly as they were", async (c) => {
    await c.register("toolbox.fetch", "1.0.0");
    // Effects recorded by work that used the adopted change: confirmed, failed, uncertain and still intended.
    const op = (operationId: string, over: Partial<OperationInput>): OperationInput => ({ operationId, epoch: c.epoch, actor: c.owner.id, correlationId: `c-${operationId}`, at: new Date(now).toISOString(), changes: [], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [], ...over });
    const D = hex("c");
    await c.storage.applyOperation(op("fx1", { effects: ["e-done", "e-failed", "e-unsure", "e-open"].map((effectId) => ({ effectId, target: `repo:${effectId}`, inputDigest: D })) }));
    await c.storage.applyOperation(op("fx2", { settleEffects: [{ effectId: "e-done", outcome: "confirmed" }, { effectId: "e-failed", outcome: "failed" }, { effectId: "e-unsure", outcome: "uncertain" }] }));
    const effects = async () => Promise.all(["e-done", "e-failed", "e-unsure", "e-open"].map((e) => c.storage.getEffect(e)));
    const fx = await effects();
    assert.deepEqual(fx.map((e) => e?.status), ["confirmed", "failed", "uncertain", "intended"]);
    const catalogBefore = JSON.stringify([await c.cat.standingOf("toolbox.fetch", "1.0.0"), await c.cat.list(c.owner)]);
    // Every operation the adoption service writes is captured.
    const seen: OperationInput[] = [];
    const spy = new Proxy(c.storage, { get(t, p, r) { const v = Reflect.get(t, p, r) as unknown; if (p === "applyOperation") return async (input: OperationInput) => { seen.push(input); return t.applyOperation(input); }; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } });
    const svc = () => c.make({ storage: spy });
    const exp = await c.experiment();
    const p1 = await c.ask(exp, PRACTICE);
    const t1 = await c.ask(exp, tool("toolbox.fetch"));
    const asked = await c.ask(await c.experiment(), PRACTICE);
    await c.approve(p1, c.owner);
    await c.approve(t1);
    seen.length = 0;
    const r = await svc().monitor(c.dev, { commandId: cid("m"), adoptionId: p1, metrics: WORSE, note: "slower than before" });
    assert.deepEqual([r.status, r.regressed], ["withdrawn", ["timeToAcceptedSeconds"]]);
    await svc().withdraw(c.mgr, { commandId: cid("w"), adoptionId: t1, expectedRevision: await c.rev(t1), reason: "we stop using it" });
    await svc().decline(c.owner, { commandId: cid("dc"), adoptionId: asked, expectedRevision: await c.rev(asked), reason: "not now" });
    assert.equal(seen.length, 3, "one write each");
    for (const s of seen) {
      assert.deepEqual([...new Set(s.changes.map((ch) => ch.ref.kind))].sort(), ["adoption", "adoption-index"], s.operationId);
      assert.deepEqual([s.effects, s.settleEffects, s.timers, s.cancelTimers, s.outbox, s.completeDeliveries, s.completeTimers], [[], [], [], [], [], [], []], s.operationId);
    }
    assert.deepEqual(await effects(), fx, "the effects are as they were recorded: nothing marked undone or settled");
    assert.equal(JSON.stringify([await c.cat.standingOf("toolbox.fetch", "1.0.0"), await c.cat.list(c.owner)]), catalogBefore, "the catalog is unchanged");
    // A further report after a restart is refused and writes nothing.
    seen.length = 0;
    const again = await svc().monitor(c.dev, { commandId: cid("m2"), adoptionId: p1, metrics: GOOD }).catch((e: unknown) => e);
    assert.ok(again instanceof DomainError && again.code === "invalid_command");
    assert.equal(seen.filter((s) => s.changes.length > 0).length, 0);
  });
}
