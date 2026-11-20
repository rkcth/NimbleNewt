import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { DeskService } from "../context/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { RetainedMaterial } from "../retention/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { commitOperation } from "../storage/commit.js";
import { pinsRef, type PinBody } from "./catalog.js";
import { CATALOG_LIMITS, CatalogService, TOOLBOX_MANAGE, versionIdOf, type HostFacts } from "./index.js";

// Card T08 (third slice): consumers stay on their pinned version of a shared tool until they opt in; the owner may move them; a revoked pin is refused, never silently replaced.
after(stopServer);

const options = { clock: () => "2026-11-20T12:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const manifest = { purpose: "lint the code", input: { type: "object" }, output: { type: "object" }, entryPoint: "bin/lint.js", interpreter: { name: "node", version: "22.19.0" }, os: ["linux"], arch: ["x64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 128, seconds: 30 }, cancellation: "cooperative", recovery: "none" };
const host: HostFacts = { os: "linux", arch: "x64", interpreters: { node: "22.19.0" }, packages: {}, cpus: 4, memoryMb: 4096 };

for (const backend of backends) {
  interface Agent { id: string; p: Principal }
  interface Ctx {
    cat: CatalogService; owner: Principal; a: string; ta: string; storage: ControllerStorage; epoch: number;
    ann: Agent; ben: Agent; rita: Agent; maint: Agent;
    /** Publishes `toolbox.lint` at this version (the maintainer), from fresh records of Ann's. */
    release(version: string): Promise<void>;
    run(by: Agent, version?: string): Promise<string>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "Garden" })).id;
        const ta = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: a, title: "T" })).id;
        const agents = AgentService.withEpoch(world.storage, projects.epoch, options);
        for (const role of ["coder", "reviewer"]) await agents.defineRole(owner, { commandId: cid("role"), name: role, capabilities: [] });
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        const cat = CatalogService.withEpoch(world.storage, projects.epoch, desks, options);
        const worker: Grant[] = [{ action: "desk.write", project: a }, { action: "desk.read", project: a }, { action: "catalog.read", project: "*" }, { action: "catalog.register", project: "*" }, { action: "tool.toolbox.lint", project: a }];
        const agent = async (friendlyName: string, grants: Grant[], roles: string[]): Promise<Agent> => {
          const id = (await agents.create(owner, { commandId: cid("ag"), friendlyName, roles })).id;
          const pid = `agent:${id}`;
          await principals.setGrants(owner, { commandId: cid("g"), principalId: pid, expectedRevision: (await principals.get(pid))!.revision, grants });
          return { id, p: await principals.authenticate((await principals.issueCredential(owner, pid)).token) };
        };
        const ann = await agent("Ann", worker, ["coder"]);
        const ben = await agent("Ben", worker, ["coder"]);
        const rita = await agent("Rita", worker, ["reviewer"]);
        const maint = await agent("Maya", [...worker, { action: TOOLBOX_MANAGE, project: "*" }], []);
        const note = async (text: string): Promise<string> => (await desks.write(ann.p, { commandId: cid("w"), projectId: a, kind: "note", title: "work", body: text, visibility: "shared", status: "accepted" } as never)).id;
        await body({
          cat, owner, a, ta, storage: world.storage, epoch: projects.epoch, ann, ben, rita, maint,
          release: async (version) => { await cat.register(maint.p, { commandId: cid("pub"), name: "toolbox.lint", kind: "tool", version, manifest, instructionsRecordId: await note(`Run lint ${version}.`), executableRecordId: await note(`console.log('lint ${version}')`), audience: { roles: ["coder"] } } as never); },
          run: async (by, version) => {
            const r = await cat.authorizeRun(by.p, { commandId: cid("run"), name: "toolbox.lint", ...(version === undefined ? {} : { version }), taskId: ta, projectId: a, host });
            assert.ok(r.ready, JSON.stringify(r));
            return r.version;
          },
        });
      } finally { await world.close(); }
    });

  suite("a consumer stays on the version of its first run after a newer release, until it opts in; a new consumer starts on the version in use", async (c) => {
    await c.release("1.0.0");
    assert.equal(await c.run(c.ann), "1.0.0", "Ann's first run");
    await c.release("1.1.0");
    // Ann is pinned: every path that resolves a call naming no version gives 1.0.0, and says it is her pin. The owner and a new consumer get the version in use.
    const got = (await c.cat.get(c.ann.p, "toolbox.lint"))!;
    assert.deepEqual([got.version, got.pinned], ["1.0.0", true]);
    assert.equal(await c.run(c.ann), "1.0.0");
    assert.deepEqual((await c.cat.list(c.ann.p)).find((x) => x.name === "toolbox.lint")?.latest, "1.0.0");
    const listed = (await c.cat.toolbox(c.ann.p)).items.find((x) => x.name === "toolbox.lint")!;
    assert.deepEqual([listed.latest, listed.pinned, listed.pinRevoked], ["1.1.0", "1.0.0", undefined]);
    assert.equal((await c.cat.source(c.ann.p, "lint")).version, "1.0.0");
    assert.equal((await c.cat.get(c.owner, "toolbox.lint"))!.version, "1.1.0");
    assert.equal((await c.cat.get(c.owner, "toolbox.lint"))!.pinned, undefined);
    assert.equal((await c.cat.get(c.ben.p, "toolbox.lint"))!.version, "1.1.0");
    assert.equal(await c.run(c.ben), "1.1.0", "Ben's first run is on the version in use");
    // Naming a version runs it and moves no pin.
    assert.equal(await c.run(c.ann, "1.1.0"), "1.1.0");
    assert.equal((await c.cat.get(c.ann.p, "toolbox.lint"))!.version, "1.0.0");
    // Ann was told once that a newer version is in use; Ben (on it) was told nothing.
    const told = (await c.cat.notices(c.ann.p)).items.filter((x) => x.kind === "release");
    assert.equal(told.length, 1);
    assert.match(told[0]!.text, /1\.1\.0 is the version in use now\. You stay on 1\.0\.0/);
    assert.equal((await c.cat.notices(c.ben.p)).items.length, 0);
    assert.deepEqual((await c.cat.pins(c.ann.p)).items, [{ name: "toolbox.lint", version: "1.0.0", inUse: "1.1.0", newer: true, setAside: false }]);
    // Opting in (default: the version in use) moves her; asking again with the same command changes nothing more.
    const optId = cid("opt");
    assert.deepEqual(await c.cat.optIn(c.ann.p, { commandId: optId, name: "lint" }), { name: "toolbox.lint", version: "1.1.0", moved: 1, previous: "1.0.0" });
    assert.deepEqual(await c.cat.optIn(c.ann.p, { commandId: optId, name: "lint" }), { name: "toolbox.lint", version: "1.1.0", moved: 0 });
    assert.equal(await c.run(c.ann), "1.1.0");
    // A later release does not move her again, and her first-use pin is never written over by a run.
    await c.release("1.2.0");
    assert.equal(await c.run(c.ann), "1.1.0");
    // Going back to an older version is her choice too.
    await c.cat.optIn(c.ann.p, { commandId: cid("opt"), name: "toolbox.lint", version: "1.0.0" });
    assert.equal(await c.run(c.ann), "1.0.0");
    // A release tells each pinned consumer once per version in use.
    assert.deepEqual((await c.cat.notices(c.ann.p)).items.filter((x) => x.kind === "release").map((x) => x.version), ["1.1.0", "1.2.0"]);
    assert.deepEqual((await c.cat.notices(c.ben.p)).items.filter((x) => x.kind === "release").map((x) => x.version), ["1.2.0"]);
  });

  suite("opting in: only a published, unrevoked version of a tool the agent may read, only for itself; the owner moves one agent or everyone and tells them; a maintainer moves nobody", async (c) => {
    await c.release("1.0.0");
    await c.run(c.ann); await c.run(c.ben);
    await c.release("1.1.0");
    await refuses("not_found", () => c.cat.optIn(c.ann.p, { commandId: cid("o"), name: "lint", version: "9.9.9" }), /no version 9\.9\.9/);
    // Rita (a reviewer) is outside the audience: the tool is answered as one that does not exist, the same as a tool that does not.
    await refuses("not_found", () => c.cat.optIn(c.rita.p, { commandId: cid("o"), name: "lint" }), /no shared tool toolbox\.lint you may read/);
    await refuses("not_found", () => c.cat.optIn(c.rita.p, { commandId: cid("o"), name: "nothing" }), /no shared tool toolbox\.nothing you may read/);
    // An agent moves only itself; a maintainer has no say over consumers either.
    const benId = c.ben.id;
    await refuses("forbidden", () => c.cat.optIn(c.ann.p, { commandId: cid("o"), name: "lint", agentId: benId }), /only for itself/);
    await refuses("forbidden", () => c.cat.optIn(c.ann.p, { commandId: cid("o"), name: "lint", everyone: true }), /only for itself/);
    await refuses("forbidden", () => c.cat.optIn(c.maint.p, { commandId: cid("o"), name: "lint", everyone: true }), /only for itself/);
    assert.equal((await c.cat.get(c.ben.p, "toolbox.lint"))!.version, "1.0.0");
    // The owner names one agent or everyone, never both or neither.
    await refuses("invalid_command", () => c.cat.optIn(c.owner, { commandId: cid("o"), name: "lint" }), /name the agent/);
    await refuses("invalid_command", () => c.cat.optIn(c.owner, { commandId: cid("o"), name: "lint", agentId: benId, everyone: true }), /name the agent/);
    await refuses("not_found", () => c.cat.optIn(c.owner, { commandId: cid("o"), name: "lint", agentId: "agt-aaaaaaaaaaaaaaaaaaaa" }), /no agent/);
    assert.deepEqual(await c.cat.optIn(c.owner, { commandId: cid("o"), name: "lint", agentId: benId }), { name: "toolbox.lint", version: "1.1.0", moved: 1, previous: "1.0.0" });
    assert.equal(await c.run(c.ben), "1.1.0");
    assert.equal(await c.run(c.ann), "1.0.0", "Ann was not moved");
    assert.match((await c.cat.notices(c.ben.p)).items.find((x) => x.kind === "pin")!.text, /The owner moved you to toolbox\.lint 1\.1\.0/);
    // Everyone: only those not already there move, and each moved agent is told.
    assert.equal((await c.cat.optIn(c.owner, { commandId: cid("o"), name: "lint", everyone: true })).moved, 1);
    assert.equal(await c.run(c.ann), "1.1.0");
    assert.equal((await c.cat.notices(c.ann.p)).items.filter((x) => x.kind === "pin").length, 1);
    assert.equal((await c.cat.notices(c.ben.p)).items.filter((x) => x.kind === "pin").length, 1, "Ben was already there");
    // A revoked version is not a version to opt in to.
    await c.cat.revoke(c.maint.p, { commandId: cid("rv"), name: "toolbox.lint", version: "1.0.0", reason: "breaks on large files", runningCalls: "finish" });
    await refuses("invalid_command", () => c.cat.optIn(c.ann.p, { commandId: cid("o"), name: "lint", version: "1.0.0" }), /revoked/);
    // Who is on what: the owner and a covering maintainer may read it; a consumer without toolbox.manage may not, an outsider is told nothing.
    const seen = await c.cat.consumers(c.owner, "lint");
    assert.deepEqual([seen.inUse, seen.pins.map((p) => [p.agent, p.version, p.how, p.by]).sort()], ["1.1.0", [[c.ann.p.id, "1.1.0", "opt-in", c.owner.id], [c.ben.p.id, "1.1.0", "opt-in", c.owner.id]].sort()]);
    assert.equal((await c.cat.consumers(c.maint.p, "toolbox.lint")).pins.length, 2);
    await refuses("forbidden", () => c.cat.consumers(c.ann.p, "lint"), /toolbox\.manage/);
    await refuses("not_found", () => c.cat.consumers(c.rita.p, "lint"));
    await refuses("forbidden", () => c.cat.pins(c.owner), /belong to agents/);
  });

  suite("a revoked pin is refused, never replaced by another version behind the consumer's back; it is told, and runs again once it opts in", async (c) => {
    await c.release("1.0.0");
    await c.run(c.ann);
    await c.release("1.1.0");
    await c.cat.revoke(c.maint.p, { commandId: cid("rv"), name: "toolbox.lint", version: "1.0.0", reason: "breaks on large files", runningCalls: "finish" });
    const got = (await c.cat.get(c.ann.p, "toolbox.lint"))!;
    assert.deepEqual([got.version, got.pinned, got.revoked?.reason], ["1.0.0", true, "breaks on large files"]);
    await refuses("forbidden", () => c.cat.authorizeRun(c.ann.p, { commandId: cid("run"), name: "toolbox.lint", taskId: c.ta, projectId: c.a, host }), /1\.0\.0 was revoked/);
    const told = (await c.cat.notices(c.ann.p)).items.filter((x) => x.kind === "revocation");
    assert.equal(told.length, 1);
    assert.match(told[0]!.text, /the version you are pinned to, was revoked: breaks on large files\. A call of it that names no version is refused until you opt in .*the version in use now is 1\.1\.0/);
    assert.deepEqual((await c.cat.pins(c.ann.p)).items[0]!.revoked?.reason, "breaks on large files");
    assert.equal((await c.cat.toolbox(c.ann.p)).items[0]!.pinRevoked, true);
    // Naming a live version still works; opting in moves the pin.
    assert.equal(await c.run(c.ann, "1.1.0"), "1.1.0");
    await c.cat.optIn(c.ann.p, { commandId: cid("o"), name: "lint" });
    assert.equal(await c.run(c.ann), "1.1.0");
  });

  suite("a pinned version set aside keeps running for its consumer, who is told; retention keeps a pinned version", async (c) => {
    await c.release("1.0.0");
    await c.run(c.ann);
    await c.release("1.1.0");
    await c.release("1.2.0");
    await c.cat.rollback(c.maint.p, { commandId: cid("rb"), name: "toolbox.lint", toVersion: "1.1.0", reason: "1.2.0 is slow" });
    await c.run(c.ben);
    await c.cat.deprecate(c.owner, { commandId: cid("dp"), name: "toolbox.lint", version: "1.0.0", reason: "superseded" });
    assert.equal(await c.run(c.ann), "1.0.0", "set aside, still her pinned version");
    assert.equal(await c.run(c.ben), "1.1.0");
    const aside = (await c.cat.notices(c.ann.p)).items.filter((x) => x.kind === "pin");
    assert.equal(aside.length, 1);
    assert.match(aside[0]!.text, /toolbox\.lint 1\.0\.0, the version you are pinned to, was set aside: superseded\. It still runs for you/);
    assert.equal((await c.cat.pins(c.ann.p)).items[0]!.setAside, true);
    // Retention's candidates include 1.0.0 (old, set aside), but the pin holds it.
    const why = (await RetainedMaterial.build(c.storage)).why("catalog-version", versionIdOf("toolbox.lint", "1.0.0"));
    assert.ok(why !== undefined && why.some((w) => w.includes(`${c.ann.p.id} is pinned to toolbox.lint 1.0.0`)), JSON.stringify(why));
    const candidates = await c.cat.retentionCandidates(c.owner, 1, 50);
    const old = candidates.items.find((x) => x.name === "toolbox.lint" && x.version === "1.0.0")!;
    const dropped = await c.cat.dropVersion(c.owner, { name: old.name, version: old.version, revision: old.revision, keep: 1 }, async (id) => (await RetainedMaterial.build(c.storage)).why("catalog-version", id));
    assert.equal(dropped.dropped, false);
    assert.equal(await c.run(c.ann), "1.0.0");
  });
  suite("first runs at the same moment pin every agent; at the limit of pinned consumers a run is never refused and the agent is pinned at a later run once there is room", async (c) => {
    await c.release("1.0.0");
    // Ann and Ben run for the first time together (Ann twice): each first-use pin is written (a lost race is asked again), the same agent twice gives one pin.
    await Promise.all([c.run(c.ann), c.run(c.ben), c.run(c.ann)]);
    assert.deepEqual((await c.cat.consumers(c.owner, "lint")).pins.map((p) => [p.agent, p.version]).sort(), [[c.ann.p.id, "1.0.0"], [c.ben.p.id, "1.0.0"]].sort());
    // Fill the record to the limit with other agents (written directly: 1000 real agents would be slow).
    const ref = pinsRef("toolbox.lint");
    const write = async (pins: PinBody["pins"], label: string): Promise<void> => {
      const found = (await c.storage.getAggregate(ref))!;
      await commitOperation(c.storage, { operationId: `cmd:fx-pins-${label}-${n++}`, epoch: c.epoch, actor: "fixture", correlationId: `fx-pins-${label}`, at: options.clock(), changes: [{ type: "update", ref, expectedRevision: found.revision, body: { name: "toolbox.lint", pins } as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] }, { attempts: 3, pause: async () => undefined });
    };
    const filler = Array.from({ length: CATALOG_LIMITS.pins }, (_, i) => ({ agent: `agent:agt-${String(i).padStart(20, "0").replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]!)}`, version: "1.0.0", at: options.clock(), by: "fixture", how: "first-use" as const }));
    await write(filler, "full");
    await c.release("1.1.0");
    const forAll = async (): Promise<void> => { await c.cat.setAudience(c.owner, { commandId: cid("aud"), name: "lint", audience: { all: true } }); };
    await forAll();
    // Rita's first run, at the limit: it is not refused, and she is not pinned. Her own opt-in is refused with the reason.
    assert.equal(await c.run(c.rita), "1.1.0");
    assert.equal((await c.cat.consumers(c.owner, "lint")).pins.some((p) => p.agent === c.rita.p.id), false);
    await refuses("unavailable", () => c.cat.optIn(c.rita.p, { commandId: cid("o"), name: "lint", version: "1.0.0" }), /1000 pinned consumers/);
    // Room again: her next run pins her (nothing was recorded under her first-use command at the limit).
    await write(filler.slice(1), "room");
    assert.equal(await c.run(c.rita), "1.1.0");
    assert.deepEqual((await c.cat.consumers(c.owner, "lint")).pins.filter((p) => p.agent === c.rita.p.id).map((p) => [p.version, p.how]), [["1.1.0", "first-use"]]);
    await c.release("1.2.0");
    await forAll();
    assert.equal(await c.run(c.rita), "1.1.0", "Rita stays on her pin after the next release");
  });
}
