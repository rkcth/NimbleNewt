import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { AssignmentService } from "../domain/assignments.js";
import { CatalogService } from "../catalog/index.js";
import { DeskService } from "../context/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { EnvironmentService, checkEnvironmentManifest, type HostCapacity } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-22T16:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const D = (c: string): string => `sha256:${c.repeat(64).slice(0, 64)}`;
const manifest = (extra: Record<string, unknown> = {}) => ({
  base: { name: "nimblenewt-base", version: "1.0.0", digest: D("a") }, packages: [{ name: "ripgrep", version: "14.1.0", digest: D("b") }], skills: [], capabilities: ["desk.write", "desk.read"],
  configuration: { installation: 3, agent: 1 }, limits: { cpus: 2, memoryMb: 2048, diskMb: 10_000, processes: 200 }, protectedExtensions: [{ name: "nimblenewt.desk", digest: D("c") }, { name: "nimblenewt.tasks", digest: D("d") }], ...extra,
});
const observed = { "nimblenewt.desk": D("c"), "nimblenewt.tasks": D("d") };


for (const backend of backends) {
  interface Ctx { env: EnvironmentService; owner: Principal; ann: Principal; ben: Principal; reserved: Map<string, string>; usable: Set<string>; attempt(who: string): Promise<string>; catalog: CatalogService; desks: DeskService; project: string; world: { storage: import("../storage/types.js").ControllerStorage }; epoch: number }
  const suite = (name: string, body: (c: Ctx) => Promise<void>, capacity?: HostCapacity) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const agent = async (nm: string, g: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const ann = await agent("ann", [{ action: "environment.manage", project: "*" }, { action: "desk.write", project: "*" }, { action: "desk.read", project: "*" }]);
        const ben = await agent("ben", [{ action: "environment.manage", project: "*" }]);
        const reserved = new Map<string, string>([["nimblenewt.desk", D("c")], ["nimblenewt.tasks", D("d")]]);
        const usable = new Set<string>();
        const env = EnvironmentService.withEpoch(world.storage, projects.epoch, { ...options, reservedDigest: async (name) => reserved.get(name), skillUsable: async (_by, id) => usable.has(id), ...(capacity === undefined ? {} : { capacity }) });
        const assign = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        const project = (await projects.createProject({ commandId: cid("pp"), actor: "owner:rob", name: "P" })).id;
        const attempt = async (who: string): Promise<string> => {
          const taskId = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: project, title: "T" })).id;
          await projects.transitionTask({ commandId: cid("ready"), actor: "owner:rob", taskId, expectedRevision: 1, to: "ready" });
          const owner_ = { kind: "agent" as const, id: who };
          await assign.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId, owner: owner_ });
          const a = (await assign.getAssignment(taskId))!;
          return (await assign.admitAttempt({ commandId: cid("ad"), actor: "worker", taskId, expectedRevision: a.revision, generation: a.generation, owner: owner_ })).id;
        };
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        await body({ env, owner, ann, ben, reserved, usable, attempt, catalog: CatalogService.withEpoch(world.storage, projects.epoch, desks, options), desks, project, world, epoch: projects.epoch });
      } finally { await world.close(); }
    });

  suite("a change makes a new revision for that agent only; another agent's environment is untouched", async (c) => {
    assert.deepEqual(await c.env.change(c.owner, { commandId: cid("c"), agentId: "agent:ann", manifest: manifest(), reason: "first" }), { revision: 1 });
    assert.deepEqual(await c.env.change(c.owner, { commandId: cid("c"), agentId: "agent:ben", manifest: manifest({ skills: [] }), reason: "first" }), { revision: 1 });
    const second = manifest({ packages: [{ name: "ripgrep", version: "14.1.0", digest: D("b") }, { name: "jq", version: "1.7.1", digest: D("e") }] });
    assert.deepEqual(await c.env.change(c.owner, { commandId: cid("c"), agentId: "agent:ann", manifest: second, reason: "add jq", expectedRevision: 1 }), { revision: 2 });
    assert.equal((await c.env.get(c.owner, "agent:ben"))!.latest, 1, "ben's environment did not move");
    assert.equal((await c.env.get(c.owner, "agent:ann", 2))!.revision!.manifest.packages.length, 2);
    assert.equal((await c.env.get(c.owner, "agent:ben", 1))!.revision!.manifest.packages.length, 1);
    assert.notEqual((await c.env.get(c.owner, "agent:ann", 1))!.revision!.digest, (await c.env.get(c.owner, "agent:ann", 2))!.revision!.digest);
    await refuses("stale_revision", () => c.env.change(c.owner, { commandId: cid("c"), agentId: "agent:ann", manifest: second, reason: "again", expectedRevision: 1 }));
    // A repeat of a command is answered from the record.
    const id = cid("c");
    assert.deepEqual(await c.env.change(c.owner, { commandId: id, agentId: "agent:ann", manifest: manifest({ skills: [] }), reason: "third", expectedRevision: 2 }), { revision: 3 });
    assert.deepEqual(await c.env.change(c.owner, { commandId: id, agentId: "agent:ann", manifest: manifest({ skills: [] }), reason: "third", expectedRevision: 2 }), { revision: 3 });
    assert.equal(await c.env.get(c.ann, "agent:ben"), undefined, "an agent does not see another's environment");
    assert.equal((await c.env.get(c.ann, "agent:ann"))!.latest, 3);
  });

  suite("an agent changes only its own packages and skills; the rest is the owner's, and it cannot make its first environment", async (c) => {
    await refuses("forbidden", () => c.env.change(c.ann, { commandId: cid("c"), agentId: "agent:ann", manifest: manifest(), reason: "mine" }), (e) => assert.match(e.message, /never creates/));
    await c.env.change(c.owner, { commandId: cid("c"), agentId: "agent:ann", manifest: manifest(), reason: "first" });
    const withPackage = manifest({ packages: [{ name: "ripgrep", version: "14.1.0", digest: D("b") }, { name: "fd", version: "10.0.0", digest: D("f") }] });
    assert.deepEqual(await c.env.change(c.ann, { commandId: cid("c"), agentId: "agent:ann", manifest: withPackage, reason: "need fd", expectedRevision: 1 }), { revision: 2 });
    for (const [what, bad] of [["limits", { limits: { cpus: 64, memoryMb: 2048, diskMb: 10_000, processes: 200 } }], ["capabilities", { capabilities: ["*"] }], ["base", { base: { name: "other", version: "1.0.0", digest: D("9") } }], ["protectedExtensions", { protectedExtensions: [] }], ["configuration", { configuration: { installation: 99 } }]] as const) {
      await refuses("forbidden", () => c.env.change(c.ann, { commandId: cid("c"), agentId: "agent:ann", manifest: { ...withPackage, ...bad }, reason: "sneaky", expectedRevision: 2 }), (e) => assert.match(e.message, new RegExp(what)));
    }
    await refuses("forbidden", () => c.env.change(c.ben, { commandId: cid("c"), agentId: "agent:ann", manifest: withPackage, reason: "not mine", expectedRevision: 2 }));
    const noGrant = c.owner.kind === "owner" ? undefined : undefined;
    void noGrant;
  });

  suite("a manifest is checked field by field, and limits keep a share of the host for the controller", async () => {
    for (const bad of [{ base: undefined }, { base: { name: "Bad Name", version: "1", digest: D("a") } }, { base: { name: "b", version: "1", digest: "abc" } }, { packages: [{ name: "x", version: "1", digest: D("a") }, { name: "x", version: "2", digest: D("a") }] }, { skills: ["nope"] }, { capabilities: ["Not An Action"] }, { configuration: { Bad: 1 } }, { configuration: { installation: -1 } }, { limits: { cpus: 0, memoryMb: 1, diskMb: 1, processes: 1 } }, { limits: undefined }, { protectedExtensions: [{ name: "toolbox.x", digest: D("a") }] }, { protectedExtensions: [{ name: "nimblenewt.x", digest: "zz" }] }, { extra: true }]) assert.throws(() => checkEnvironmentManifest({ ...manifest(), ...bad }), (e) => e instanceof DomainError && e.code === "invalid_command", JSON.stringify(bad).slice(0, 50));
    const host = { cpus: 8, memoryMb: 16_000, diskMb: 100_000, processes: 2000 };
    assert.doesNotThrow(() => checkEnvironmentManifest(manifest({ limits: { cpus: 7, memoryMb: 14_400, diskMb: 90_000, processes: 1800 } }), host));
    for (const key of ["cpus", "memoryMb", "diskMb", "processes"] as const) assert.throws(() => checkEnvironmentManifest(manifest({ limits: { cpus: 1, memoryMb: 1, diskMb: 1, processes: 1, [key]: host[key] } }), host), (e) => e instanceof DomainError && /kept for the controller/.test(e.message), key);
  });

  suite("activation verifies the protected extensions against the catalog and the disk; a failure activates nothing and the previous revision stays", async (c) => {
    await c.env.change(c.owner, { commandId: cid("c"), agentId: "agent:ann", manifest: manifest(), reason: "first" });
    await refuses("forbidden", () => c.env.activate(c.ann, { commandId: cid("a"), agentId: "agent:ann", revision: 1, observed }));
    await refuses("not_found", () => c.env.activate(c.owner, { commandId: cid("a"), agentId: "agent:ann", revision: 9, observed }));
    for (const [what, observedBad, mutate] of [
      ["missing on disk", { "nimblenewt.desk": D("c") }, undefined],
      ["changed on disk", { ...observed, "nimblenewt.tasks": D("0") }, undefined],
      ["loaded but not named", { ...observed, "nimblenewt.extra": D("1") }, undefined],
      ["not the catalog's", observed, () => c.reserved.set("nimblenewt.desk", D("2"))],
      ["not in the catalog", observed, () => c.reserved.delete("nimblenewt.tasks")],
    ] as const) {
      mutate?.();
      await refuses("integrity", () => c.env.activate(c.owner, { commandId: cid("a"), agentId: "agent:ann", revision: 1, observed: observedBad }), (e) => assert.ok(e.message.length > 30, what));
      c.reserved.set("nimblenewt.desk", D("c")); c.reserved.set("nimblenewt.tasks", D("d"));
    }
    assert.equal((await c.env.get(c.owner, "agent:ann"))!.active, undefined, "nothing was activated");
    await c.env.activate(c.owner, { commandId: cid("a"), agentId: "agent:ann", revision: 1, observed });
    assert.equal((await c.env.get(c.owner, "agent:ann"))!.active!.revision, 1);
    // A later revision that fails keeps revision 1 active.
    await c.env.change(c.owner, { commandId: cid("c"), agentId: "agent:ann", manifest: manifest({ packages: [] }), reason: "second", expectedRevision: 1 });
    await refuses("integrity", () => c.env.activate(c.owner, { commandId: cid("a"), agentId: "agent:ann", revision: 2, observed: {} }));
    assert.equal((await c.env.get(c.owner, "agent:ann"))!.active!.revision, 1);
  });

  suite("an attempt and a checkpoint resume on the exact revision they ran with, after the environment moved on; rollback makes a new revision from an old one", async (c) => {
    const A = await c.attempt("ann"); const B = await c.attempt("ann"); const X = await c.attempt("ben");
    await c.env.change(c.owner, { commandId: cid("c"), agentId: "agent:ann", manifest: manifest(), reason: "first" });
    await refuses("invalid_command", () => c.env.pin(c.ann, { commandId: cid("p"), attemptId: A, agentId: "agent:ann", kind: "attempt" }), (e) => assert.match(e.message, /no active/));
    await c.env.activate(c.owner, { commandId: cid("a"), agentId: "agent:ann", revision: 1, observed });
    const pin = await c.env.pin(c.ann, { commandId: cid("p"), attemptId: A, agentId: "agent:ann", kind: "attempt" });
    assert.deepEqual([pin.revision, pin.kind], [1, "attempt"]);
    await c.env.change(c.owner, { commandId: cid("c"), agentId: "agent:ann", manifest: manifest({ packages: [] }), reason: "second", expectedRevision: 1 });
    await c.env.activate(c.owner, { commandId: cid("a"), agentId: "agent:ann", revision: 2, observed });
    assert.deepEqual(await c.env.pin(c.ann, { commandId: cid("p"), attemptId: A, agentId: "agent:ann", kind: "attempt" }), pin, "pinning again gives the same pin");
    const second = await c.env.pin(c.ann, { commandId: cid("p"), attemptId: B, agentId: "agent:ann", kind: "checkpoint" });
    assert.equal(second.revision, 2);
    const resumed = await c.env.resume(c.ann, A);
    assert.deepEqual([resumed.revision, resumed.manifest.packages.length, resumed.pin.digest === resumed.digest], [1, 1, true], "the attempt resumes on revision 1");
    assert.equal((await c.env.resume(c.owner, B, "checkpoint")).revision, 2);
    await refuses("forbidden", () => c.env.resume(c.ben, A));
    await refuses("forbidden", () => c.env.pin(c.ben, { commandId: cid("p"), attemptId: X, agentId: "agent:ann", kind: "attempt" }));
    // One agent cannot claim another's attempt by pinning it: ben's attempt is not ann's, and ben pinning it to himself needs his own environment first.
    await refuses("forbidden", () => c.env.pin(c.ann, { commandId: cid("p"), attemptId: X, agentId: "agent:ann", kind: "attempt" }), (e) => assert.match(e.message, /not an attempt of/));
    await refuses("forbidden", () => c.env.pin(c.owner, { commandId: cid("p"), attemptId: X, agentId: "agent:ann", kind: "attempt" }));
    await refuses("forbidden", () => c.env.resume(c.ann, "att-zzzzzzzzzzzzzzzzzzzz"));
    // Rollback to revision 1: a new revision 3 with the old manifest, active, history kept.
    const rolled = await c.env.rollback(c.owner, { commandId: cid("r"), agentId: "agent:ann", toRevision: 1, reason: "jq broke things", observed, expectedRevision: 2 });
    assert.deepEqual([rolled.revision, rolled.activated], [3, true]);
    const now = (await c.env.get(c.owner, "agent:ann"))!;
    assert.deepEqual([now.active!.revision, now.active!.rollbackOf, now.active!.digest === (await c.env.get(c.owner, "agent:ann", 1))!.revision!.digest, now.latest], [3, 1, true, 3]);
    await refuses("not_found", () => c.env.rollback(c.owner, { commandId: cid("r"), agentId: "agent:ann", toRevision: 9, reason: "x", observed, expectedRevision: 3 }));
    await refuses("forbidden", () => c.env.rollback(c.ann, { commandId: cid("r"), agentId: "agent:ann", toRevision: 1, reason: "x", observed, expectedRevision: 3 }));
  });

  suite("a home is the agent's and the owner's alone, and each agent has its own", async (c) => {
    const a = c.env.authorizeHome(c.ann, "agent:ann");
    assert.equal(c.env.authorizeHome(c.owner, "agent:ann"), a);
    assert.notEqual(c.env.authorizeHome(c.ben, "agent:ben"), a);
    assert.throws(() => c.env.authorizeHome(c.ben, "agent:ann"), (e) => e instanceof DomainError && e.code === "forbidden");
    assert.throws(() => c.env.authorizeHome(c.ann, "../agent:ann"), DomainError);
    assert.match(a, /^agent-[0-9a-f]{24}$/);
  });

  suite("skills must exist, be unrevoked and be the changer's to use; a rollback whose activation fails still makes the revision, and a repeat finishes it", async (c) => {
    const cav = "cav-aaaaaaaaaaaaaaaaaaaa"; const other = "cav-bbbbbbbbbbbbbbbbbbbb";
    await refuses("forbidden", () => c.env.change(c.owner, { commandId: cid("c"), agentId: "agent:ann", manifest: manifest({ skills: [cav] }), reason: "skill" }), (e) => assert.match(e.message, /not a catalog version you may/));
    c.usable.add(cav);
    await c.env.change(c.owner, { commandId: cid("c"), agentId: "agent:ann", manifest: manifest({ skills: [cav] }), reason: "skill" });
    await refuses("forbidden", () => c.env.change(c.ann, { commandId: cid("c"), agentId: "agent:ann", manifest: manifest({ skills: [cav, other] }), reason: "mine", expectedRevision: 1 }));
    // A skill revoked after the revision was made stops its activation.
    c.usable.delete(cav);
    await refuses("integrity", () => c.env.activate(c.owner, { commandId: cid("a"), agentId: "agent:ann", revision: 1, observed }), (e) => assert.match(e.message, /skill library/));
    c.usable.add(cav);
    await c.env.activate(c.owner, { commandId: cid("a"), agentId: "agent:ann", revision: 1, observed });
    await c.env.change(c.owner, { commandId: cid("c"), agentId: "agent:ann", manifest: manifest({ skills: [] }), reason: "second", expectedRevision: 1 });
    await c.env.activate(c.owner, { commandId: cid("a"), agentId: "agent:ann", revision: 2, observed });
    // Rolling back to revision 1 while a protected extension on disk is wrong: the new revision exists, is not active, and the answer says so; the same command later finishes it.
    const id = cid("r");
    const first = await c.env.rollback(c.owner, { commandId: id, agentId: "agent:ann", toRevision: 1, reason: "back", observed: {}, expectedRevision: 2 });
    assert.deepEqual([first.revision, first.activated, typeof first.problem], [3, false, "string"]);
    assert.equal((await c.env.get(c.owner, "agent:ann"))!.active!.revision, 2, "the previous revision stays active");
    const again = await c.env.rollback(c.owner, { commandId: id, agentId: "agent:ann", toRevision: 1, reason: "back", observed, expectedRevision: 2 });
    assert.deepEqual([again.revision, again.activated], [3, true]);
    assert.equal((await c.env.get(c.owner, "agent:ann"))!.active!.revision, 3);
  });

  suite("activation compares against the real catalog: the executable digest of the latest live system version", async (c) => {
    const body = "console.log('the desk tool')";
    const record = await c.desks.write(c.ann, { commandId: cid("w"), projectId: c.project, kind: "note", title: "tool", body, visibility: "shared", status: "accepted" } as never);
    const m = { purpose: "desk access", input: { type: "object" }, output: { type: "object" }, entryPoint: "bin/desk.js", interpreter: { name: "node", version: "22.19.0" }, os: ["linux"], arch: ["x64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 128, seconds: 30 }, cancellation: "cooperative", recovery: "restart" };
    await c.catalog.register(c.owner, { commandId: cid("cr"), name: "nimblenewt.desk", kind: "tool", version: "1.0.0", manifest: m, instructionsRecordId: record.id, executableRecordId: record.id });
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    assert.equal(await c.catalog.systemDigest("nimblenewt.desk"), digest);
    assert.equal(await c.catalog.systemDigest("toolbox.desk"), undefined);
    assert.equal(await c.catalog.systemDigest("nimblenewt.nothing"), undefined);
    const real = EnvironmentService.withEpoch(c.world.storage, c.epoch, { ...options, reservedDigest: (name) => c.catalog.systemDigest(name), skillUsable: (by, id) => c.catalog.usableVersion(by, id) });
    await real.change(c.owner, { commandId: cid("c"), agentId: "agent:ann", manifest: manifest({ protectedExtensions: [{ name: "nimblenewt.desk", digest }] }), reason: "real" });
    await refuses("integrity", () => real.activate(c.owner, { commandId: cid("a"), agentId: "agent:ann", revision: 1, observed: { "nimblenewt.desk": D("0") } }));
    await real.activate(c.owner, { commandId: cid("a"), agentId: "agent:ann", revision: 1, observed: { "nimblenewt.desk": digest } });
    assert.equal((await real.get(c.owner, "agent:ann"))!.active!.revision, 1);
    // A manifest that names a digest the catalog does not hold is refused at activation.
    await real.change(c.owner, { commandId: cid("c"), agentId: "agent:ann", manifest: manifest({ protectedExtensions: [{ name: "nimblenewt.desk", digest: D("9") }] }), reason: "wrong", expectedRevision: 1 });
    await refuses("integrity", () => real.activate(c.owner, { commandId: cid("a"), agentId: "agent:ann", revision: 2, observed: { "nimblenewt.desk": D("9") } }), (e) => assert.match(e.message, /not the catalog's/));
    // The catalog's own rule for who may use a skill.
    assert.equal(await c.catalog.usableVersion(c.owner, "cav-aaaaaaaaaaaaaaaaaaaa"), false);
  });

  suite("limits keep at least one unit on a small host, and a reserve fraction must be between 0 and 1", async () => {
    const tiny = { cpus: 1, memoryMb: 512, diskMb: 1024, processes: 8 };
    assert.doesNotThrow(() => checkEnvironmentManifest(manifest({ limits: { cpus: 1, memoryMb: 400, diskMb: 900, processes: 7 } }), tiny));
    assert.throws(() => checkEnvironmentManifest(manifest({ limits: { cpus: 2, memoryMb: 1, diskMb: 1, processes: 1 } }), tiny), DomainError);
    assert.throws(() => EnvironmentService.withEpoch(undefined as never, 1, { reservedDigest: async () => undefined, skillUsable: async () => true, capacity: { ...tiny, reserveFraction: 1 } }), RangeError);
    assert.throws(() => EnvironmentService.withEpoch(undefined as never, 1, { reservedDigest: async () => undefined, skillUsable: async () => true, capacity: { ...tiny, reserveFraction: -0.1 } }), RangeError);
  });
}
