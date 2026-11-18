import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { DeskService } from "../context/index.js";
import { DependencyService } from "../dependencies/index.js";
import { derivedId } from "../domain/ids.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ACTIONS } from "../security/access.js";
import { AGREED_GRANTABLE_ACTIONS, AGREED_GRANTABLE_ON_ONE_SERVICE, AGREED_GRANTABLE_ON_ONE_TASK } from "../security/grants.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { CatalogService, TOOLBOX_MANAGE, mayManage, personalNamespace, toolboxName, type HostFacts } from "./index.js";

// Card T08 (first slice): the scoped toolbox.manage permission, audiences, read-only source, personal copies with provenance and fork lineage.
after(stopServer);

const options = { clock: () => "2026-11-18T12:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const manifest = { purpose: "lint the code", input: { type: "object" }, output: { type: "object" }, entryPoint: "bin/lint.js", interpreter: { name: "node", version: "22.19.0" }, os: ["linux"], arch: ["x64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 128, seconds: 30 }, cancellation: "cooperative", recovery: "none" };
const host: HostFacts = { os: "linux", arch: "x64", interpreters: { node: "22.19.0" }, packages: {}, cpus: 4, memoryMb: 4096 };

for (const backend of backends) {
  interface Ctx {
    cat: CatalogService; deps: DependencyService; desks: DeskService; agents: AgentService; principals: PrincipalService; owner: Principal; a: string; b: string; ta: string; tb: string; web: string; storage: ControllerStorage; epoch: number;
    /** An agent record with roles and a team, and its authenticated principal with these grants. */
    agent(name: string, grants: Grant[], extra?: { roles?: string[]; teamId?: string }): Promise<{ id: string; p: Principal; reauth(): Promise<Principal> }>;
    note(by: Principal, body: string, extra?: Record<string, unknown>): Promise<string>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "Garden" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: owner.id, name: "Orchard" })).id;
        const ta = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: a, title: "T" })).id;
        const tb = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: b, title: "U" })).id;
        const agents = AgentService.withEpoch(world.storage, projects.epoch, options);
        for (const role of ["coder", "reviewer", "lead"]) await agents.defineRole(owner, { commandId: cid("role"), name: role, capabilities: [] });
        const web = (await agents.createTeam(owner, { commandId: cid("team"), name: "web" })).id;
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        await body({
          cat: CatalogService.withEpoch(world.storage, projects.epoch, desks, options), deps: DependencyService.withEpoch(world.storage, projects.epoch, options), desks, agents, principals, owner, a, b, ta, tb, web, storage: world.storage, epoch: projects.epoch,
          agent: async (friendlyName, grants, extra = {}) => {
            const id = (await agents.create(owner, { commandId: cid("ag"), friendlyName, ...(extra.roles === undefined ? {} : { roles: extra.roles }), ...(extra.teamId === undefined ? {} : { teamId: extra.teamId }) })).id;
            const pid = `agent:${id}`;
            await principals.setGrants(owner, { commandId: cid("g"), principalId: pid, expectedRevision: (await principals.get(pid))!.revision, grants });
            const reauth = async () => principals.authenticate((await principals.issueCredential(owner, `agent:${id}`)).token);
            return { id, p: await reauth(), reauth };
          },
          note: async (by, text, extra = {}) => (await desks.write(by, { commandId: cid("w"), projectId: a, kind: "note", title: "work", body: text, visibility: "shared", status: "accepted", ...extra } as never)).id,
        });
      } finally { await world.close(); }
    });

  const worker = (p: string): Grant[] => [{ action: "desk.write", project: p }, { action: "desk.read", project: p }, { action: "catalog.read", project: "*" }, { action: "catalog.register", project: "*" }];

  suite("toolbox.manage is a grant on a durable identity: a maintainer publishes shared tools, a role or a name gives nothing, and it never covers nimblenewt commands", async (c) => {
    assert.ok((ACTIONS as readonly string[]).includes(TOOLBOX_MANAGE));
    const ann = await c.agent("Ann", worker(c.a), { roles: ["coder"] });
    const lead = await c.agent("Lead", worker(c.a), { roles: ["lead"] });
    const maint = await c.agent("Maya", [...worker(c.a), { action: TOOLBOX_MANAGE, project: "*" }]);
    const readme = await c.note(ann.p, "Run lint on the changed files."); const code = await c.note(ann.p, "console.log('lint')");
    const publish = (by: Principal, extra: Record<string, unknown> = {}) => c.cat.register(by, { commandId: cid("pub"), name: "toolbox.lint", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: readme, executableRecordId: code, audience: { roles: ["coder"] }, ...extra } as never);
    // A lead role (a title) without the grant cannot publish; neither can an agent with only catalog.register.
    await refuses("forbidden", () => publish(lead.p), /toolbox\.manage/);
    await refuses("forbidden", () => publish(ann.p), /toolbox\.manage/);
    // A maintainer's first release names who it is for.
    await refuses("invalid_command", () => publish(maint.p, { audience: undefined }), /names who a new shared tool is for/);
    const v1 = await publish(maint.p);
    assert.equal(v1.name, "toolbox.lint");
    const got = (await c.cat.get(c.owner, "toolbox.lint"))!;
    assert.deepEqual([got.registeredBy, got.instructional.author, got.layer], [maint.p.id, ann.p.id, "toolbox"], "the maintainer released it; the author stays recorded");
    // The maintainer (no role) sees and reads what it manages, but running it still needs the audience.
    assert.notEqual(await c.cat.get(maint.p, "toolbox.lint"), undefined);
    await refuses("forbidden", () => c.cat.authorizeRun(maint.p, { commandId: cid("run"), name: "toolbox.lint", taskId: c.ta, projectId: c.a, host }), /may not use/);
    // Never NimbleNewt's own commands, never another agent's namespace.
    await refuses("forbidden", () => publish(maint.p, { name: "nimblenewt.lint" }), /nimblenewt/);
    await refuses("invalid_command", () => publish(maint.p, { name: `${personalNamespace(ann.p.id)}.lint`, audience: undefined }));
    // Private scratch, a draft and a record it cannot read are not released.
    const scratch = await c.note(ann.p, "secret plan", { visibility: "private" });
    await refuses("forbidden", () => publish(maint.p, { version: "1.1.0", instructionsRecordId: scratch }));
    const draft = await c.note(ann.p, "half done", { status: "draft" });
    await refuses("forbidden", () => publish(maint.p, { version: "1.1.0", executableRecordId: draft }), /may not read/);
    const outsider = await c.agent("Otto", [{ action: TOOLBOX_MANAGE, project: "*" }, { action: "catalog.read", project: "*" }]);
    await refuses("forbidden", () => publish(outsider.p, { version: "1.1.0" }));
    // Renaming the maintainer changes nothing: the grant is on agent:<ID>.
    await c.agents.update(c.owner, { commandId: cid("ren"), agentId: maint.id, expectedRevision: 1, friendlyName: "Maya Renamed" });
    const code2 = await c.note(ann.p, "console.log('lint 2')");
    assert.equal((await publish(await maint.reauth(), { version: "1.1.0", executableRecordId: code2 })).name, "toolbox.lint");
    // A meeting decision cannot grant it: it is in none of the lists a decision may grant.
    for (const list of [AGREED_GRANTABLE_ACTIONS, AGREED_GRANTABLE_ON_ONE_TASK, AGREED_GRANTABLE_ON_ONE_SERVICE]) assert.ok(!list.includes(TOOLBOX_MANAGE));
  });

  suite("an audience decides who finds, reads and runs a shared tool: roles, a team, a project (for runs, only that project), all agents; source inspection needs no manage permission", async (c) => {
    const ann = await c.agent("Ann", worker(c.a));
    const coder = await c.agent("Cody", [...worker(c.a), { action: "tool.toolbox.lint", project: c.a }, { action: "tool.toolbox.lint", project: c.b }], { roles: ["coder"] });
    const rev = await c.agent("Rita", [...worker(c.a), { action: "tool.toolbox.lint", project: c.a }], { roles: ["reviewer"] });
    const readme = await c.note(ann.p, "Run lint."); const code = await c.note(ann.p, "console.log('lint')");
    await c.cat.register(c.owner, { commandId: cid("pub"), name: "toolbox.lint", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: readme, executableRecordId: code, audience: { roles: ["coder"] } } as never);
    const sees = async (p: Principal) => (await c.cat.get(p, "toolbox.lint")) !== undefined && (await c.cat.list(p)).some((x) => x.name === "toolbox.lint") && (await c.cat.toolbox(p)).items.some((x) => x.name === "toolbox.lint");
    assert.equal(await sees(coder.p), true);
    assert.equal(await sees(rev.p), false, "a role outside the audience does not discover it");
    const src = await c.cat.source(coder.p, "lint");
    assert.deepEqual([src.name, src.version, src.instructions, src.executable, src.author], ["toolbox.lint", "1.0.0", "Run lint.", "console.log('lint')", ann.p.id]);
    assert.deepEqual(Object.keys(src).sort(), ["author", "digest", "executable", "instructions", "kind", "manifest", "name", "version"], "only the released material is shown");
    await refuses("not_found", () => c.cat.source(rev.p, "lint"));
    // An excluded role cannot run it even with a grant naming the tool.
    await refuses("forbidden", () => c.cat.authorizeRun(rev.p, { commandId: cid("run"), name: "toolbox.lint", taskId: c.ta, projectId: c.a, host }));
    assert.equal((await c.cat.authorizeRun(coder.p, { commandId: cid("run"), name: "toolbox.lint", taskId: c.ta, projectId: c.a, host })).ready, true);
    // A team audience, stored by ID though given by name.
    await c.agents.update(c.owner, { commandId: cid("u"), agentId: rev.id, expectedRevision: 1, teamId: c.web });
    const set = await c.cat.setAudience(c.owner, { commandId: cid("aud"), name: "lint", audience: { teams: ["web"] } });
    assert.deepEqual(set.audience, { teams: [c.web] });
    assert.equal(await sees(await rev.reauth()), true);
    assert.equal(await sees(coder.p), false);
    await refuses("invalid_command", () => c.cat.setAudience(c.owner, { commandId: cid("aud"), name: "lint", audience: { teams: ["nobody"] } }), /no team/);
    await refuses("invalid_command", () => c.cat.setAudience(c.owner, { commandId: cid("aud"), name: "lint", audience: { roles: ["ghost"] } }), /not defined/);
    await refuses("invalid_command", () => c.cat.setAudience(c.owner, { commandId: cid("aud"), name: "lint", audience: { all: true, roles: ["coder"] } }), /stands alone/);
    // A project audience: a grant naming that project; a run only in that project.
    await c.cat.setAudience(c.owner, { commandId: cid("aud"), name: "lint", audience: { projects: ["Orchard"] } });
    assert.equal(await sees(coder.p), true, "Cody holds a grant naming Orchard");
    assert.equal(await sees(ann.p), false, "Ann's grants name Garden only (her catalog.read for every project is not membership)");
    await refuses("forbidden", () => c.cat.authorizeRun(coder.p, { commandId: cid("run"), name: "toolbox.lint", taskId: c.ta, projectId: c.a, host }));
    assert.equal((await c.cat.authorizeRun(coder.p, { commandId: cid("run"), name: "toolbox.lint", taskId: c.tb, projectId: c.b, host })).ready, true);
    // Back to all agents.
    await c.cat.setAudience(c.owner, { commandId: cid("aud"), name: "lint", audience: { all: true } });
    assert.equal(await sees(ann.p), true);
    // A retired agent belongs to no role audience.
    await c.cat.setAudience(c.owner, { commandId: cid("aud"), name: "lint", audience: { roles: ["coder"] } });
    await c.agents.retire(c.owner, { agentId: coder.id, expectedRevision: 1, commandId: cid("ret") });
    assert.equal(await sees(coder.p), false);
    // The released version survives its author being renamed or retired.
    await c.agents.update(c.owner, { commandId: cid("u"), agentId: ann.id, expectedRevision: 1, friendlyName: "Ann B" });
    await c.agents.retire(c.owner, { agentId: ann.id, expectedRevision: 2, commandId: cid("ret") });
    assert.equal((await c.cat.source(c.owner, "toolbox.lint")).executable, "console.log('lint')");
  });

  suite("a maintainer scoped to one project manages only tools for that project's audience; widening or taking over another entry fails", async (c) => {
    const ann = await c.agent("Ann", worker(c.a));
    const pm = await c.agent("Pat", [...worker(c.a), { action: TOOLBOX_MANAGE, project: c.a }]);
    const readme = await c.note(ann.p, "Run fmt."); const code = await c.note(ann.p, "console.log('fmt')");
    const pub = (name: string, audience: unknown, version = "1.0.0") => c.cat.register(pm.p, { commandId: cid("pub"), name, kind: "tool", version, manifest, instructionsRecordId: readme, executableRecordId: code, audience } as never);
    await refuses("forbidden", () => pub("toolbox.fmt", { all: true }), /does not cover/);
    await refuses("forbidden", () => pub("toolbox.fmt", { roles: ["coder"] }));
    await refuses("forbidden", () => pub("toolbox.fmt", { projects: [c.a, c.b] }));
    await pub("toolbox.fmt", { projects: ["Garden"] });
    assert.ok((await c.cat.toolbox(pm.p)).items.find((x) => x.name === "toolbox.fmt")?.maintainable);
    await refuses("forbidden", () => c.cat.setAudience(pm.p, { commandId: cid("aud"), name: "fmt", audience: { all: true } }));
    // The owner's entry for all agents is not the project maintainer's to change, roll back or read the forks of.
    await c.cat.register(c.owner, { commandId: cid("pub"), name: "toolbox.lint", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: readme, executableRecordId: code } as never);
    await c.cat.register(c.owner, { commandId: cid("pub"), name: "toolbox.lint", kind: "tool", version: "1.1.0", manifest: { ...manifest, purpose: "lint v2" }, instructionsRecordId: readme, executableRecordId: code } as never);
    await refuses("forbidden", () => c.cat.setAudience(pm.p, { commandId: cid("aud"), name: "lint", audience: { projects: [c.a] } }), /present audience/);
    await refuses("forbidden", () => c.cat.rollback(pm.p, { commandId: cid("rb"), name: "toolbox.lint", toVersion: "1.0.0", reason: "try" }));
    await refuses("forbidden", () => c.cat.forks(pm.p, "lint"));
    await refuses("forbidden", () => pub("toolbox.lint", { projects: [c.a] }, "1.2.0"), /does not cover that tool's audience/);
    // Its own entry: update, roll back, deprecate.
    await pub("toolbox.fmt", undefined, "1.1.0");
    await c.cat.rollback(pm.p, { commandId: cid("rb"), name: "toolbox.fmt", toVersion: "1.0.0", reason: "1.1.0 misformats" });
    assert.equal((await c.cat.get(c.owner, "toolbox.fmt"))!.version, "1.0.0");
    assert.deepEqual((await c.cat.forks(pm.p, "fmt")).forks, []);
    // Only the owner revokes (this slice), and protected names stay the owner's.
    await refuses("forbidden", () => c.cat.revoke(pm.p, { commandId: cid("rv"), name: "toolbox.fmt", version: "1.1.0", reason: "x" }));
    await refuses("forbidden", () => c.cat.deprecate(pm.p, { commandId: cid("dp"), name: "nimblenewt.fmt", version: "1.0.0", reason: "x" }));
    assert.equal(mayManage(pm.p, { projects: [c.a] }), true);
    assert.equal(mayManage(pm.p, undefined), false, "an entry with no audience is for all agents");
    assert.equal(toolboxName("fmt"), "toolbox.fmt");
    assert.throws(() => toolboxName("nimblenewt.fmt"));
  });

  suite("a personal copy keeps its provenance, inherits no grant, never takes the shared name, is untouched by later releases, and is told of a revocation of its base", async (c) => {
    const ann = await c.agent("Ann", worker(c.a));
    const cody = await c.agent("Cody", [...worker(c.a), { action: "tool.toolbox.lint", project: c.a }], { roles: ["coder"] });
    const rita = await c.agent("Rita", worker(c.a), { roles: ["reviewer"] });
    const readme = await c.note(ann.p, "Run lint."); const code = await c.note(ann.p, "console.log('lint')"); const code2 = await c.note(ann.p, "console.log('lint 2')");
    const v1 = await c.cat.register(c.owner, { commandId: cid("pub"), name: "toolbox.lint", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: readme, executableRecordId: code, audience: { roles: ["coder"] } } as never);
    await refuses("not_found", () => c.cat.copy(rita.p, { commandId: cid("cp"), name: "lint", as: "my-lint" }), /you may read/);
    const copy = await c.cat.copy(cody.p, { commandId: cid("cp"), name: "lint", as: "my-lint" });
    const mine = `${personalNamespace(cody.p.id)}.my-lint`;
    assert.equal(copy.name, mine);
    assert.deepEqual(copy.copiedFrom, { name: "toolbox.lint", version: "1.0.0", digest: v1.digest });
    assert.notEqual(copy.digest, v1.digest, "the copy has its own identity");
    const src = await c.cat.source(cody.p, mine);
    assert.deepEqual([src.executable, src.copiedFrom?.version], ["console.log('lint')", "1.0.0"]);
    // The copy inherits no grant: the shared tool's grant does not reach it. It runs only under the agent's own standing grant for its namespace (`tool.a-<id>.*`, given to every agent record).
    const sharedOnly: Principal = { ...cody.p, grants: cody.p.grants.filter((g) => !g.action.startsWith("tool.a-")) };
    assert.ok(cody.p.grants.some((g) => g.action === `tool.${personalNamespace(cody.p.id).replace(/^a_/, "a-")}.*`));
    await refuses("forbidden", () => c.cat.authorizeRun(sharedOnly, { commandId: cid("run"), name: mine, taskId: c.ta, projectId: c.a, host }), /no grant/);
    assert.equal((await c.cat.authorizeRun(cody.p, { commandId: cid("run"), name: mine, taskId: c.ta, projectId: c.a, host })).ready, true);
    // The shared name stays bound to the shared release, for the copier too.
    assert.equal((await c.cat.get(cody.p, "toolbox.lint"))!.digest, v1.digest);
    assert.equal((await c.cat.get(rita.p, mine)), undefined, "a copy is personal");
    // A later shared release leaves the copy alone; the copier is told a newer one exists.
    await c.cat.register(c.owner, { commandId: cid("pub"), name: "toolbox.lint", kind: "tool", version: "1.1.0", manifest, instructionsRecordId: readme, executableRecordId: code2 } as never);
    assert.equal((await c.cat.get(cody.p, mine))!.copiedFrom!.version, "1.0.0");
    let listed = (await c.cat.copies(cody.p)).items;
    assert.deepEqual(listed.map((x) => [x.name, x.copiedFrom.version, x.sharedLatest, x.newerShared, x.baseRevoked]), [[mine, "1.0.0", "1.1.0", true, undefined]]);
    // Copying again must go up; the same command is answered again.
    await refuses("invalid_command", () => c.cat.copy(cody.p, { commandId: cid("cp"), name: "lint", as: "my-lint" }), /higher copyVersion/);
    const second = await c.cat.copy(cody.p, { commandId: cid("cp"), name: "lint", as: "my-lint", copyVersion: "2.0.0" });
    assert.equal(second.copiedFrom.version, "1.1.0");
    // Lineage, and a revocation reaching the forks of that base.
    let forks = (await c.cat.forks(c.owner, "lint")).forks;
    assert.deepEqual(forks.map((f) => [f.copy, f.version, f.baseVersion, f.owner, f.baseRevoked]), [[mine, "1.0.0", "1.0.0", cody.p.id, false], [mine, "2.0.0", "1.1.0", cody.p.id, false]]);
    await c.cat.revoke(c.owner, { commandId: cid("rv"), name: "toolbox.lint", version: "1.1.0", reason: "it deletes files" });
    forks = (await c.cat.forks(c.owner, "lint")).forks;
    assert.deepEqual(forks.map((f) => f.baseRevoked), [false, true]);
    listed = (await c.cat.copies(cody.p)).items;
    assert.equal(listed[0]!.baseRevoked?.reason, "it deletes files", "the revocation notice reaches the fork");
    await refuses("invalid_command", () => c.cat.copy(cody.p, { commandId: cid("cp"), name: "lint", version: "1.1.0", as: "other" }), /revoked/);
    // An audience change does not take back a copy already made.
    await c.cat.setAudience(c.owner, { commandId: cid("aud"), name: "lint", audience: { roles: ["reviewer"] } });
    assert.equal((await c.cat.copies(cody.p)).items[0]!.sharedLatest, undefined, "the shared tool is no longer visible to Cody");
    assert.notEqual(await c.cat.get(cody.p, mine), undefined);
    // A host or the owner keeps no personal copies.
    await refuses("forbidden", () => c.cat.copy(c.owner, { commandId: cid("cp"), name: "lint", as: "x" }));
  });

  suite("dependency records judge a shared tool by its audience too: an agent outside it learns neither that a version exists nor whether a digest is right (review fix)", async (c) => {
    const work = (p: string): Grant[] => [...worker(p), { action: "attempt.work", project: p }];
    const cody = await c.agent("Cody", work(c.a), { roles: ["coder"] });
    const rex = await c.agent("Rex", work(c.a), { roles: ["reviewer"] });
    const readme = await c.note(cody.p, "Run lint on the changed files."); const code = await c.note(cody.p, "console.log('lint')");
    const v = await c.cat.register(c.owner, { commandId: cid("pub"), name: "toolbox.lint", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: readme, executableRecordId: code, audience: { roles: ["coder"] } } as never);
    const wrong = `sha256:${"0".repeat(64)}`;
    const toolDep = (hash: string) => [{ kind: "tool-version" as const, key: v.versionId, hash }];
    const absent = [{ kind: "negative" as const, key: `catalog-entry:${derivedId("cat", "toolbox.lint")}` }];
    // In the audience: a wrong digest and a false "it does not exist" are refused, as before.
    await refuses("invalid_command", () => c.deps.record(cody.p, { commandId: cid("dep"), taskId: c.ta, dependencies: toolDep(wrong) }), /not the version's digest/);
    await refuses("invalid_command", () => c.deps.record(cody.p, { commandId: cid("dep"), taskId: c.ta, dependencies: absent }), /exists/);
    await c.deps.record(cody.p, { commandId: cid("dep"), taskId: c.ta, dependencies: toolDep(v.digest.startsWith("sha256:") ? v.digest : `sha256:${v.digest}`) });
    // Outside it (catalog.read and work in the project, but not a coder): both are recorded unverified, so neither answer tells it anything.
    await c.deps.record(rex.p, { commandId: cid("dep"), taskId: c.ta, dependencies: toolDep(wrong) });
    await c.deps.record(rex.p, { commandId: cid("dep"), taskId: c.ta, dependencies: absent });
    // Once the owner widens the audience, the same reader is checked.
    await c.cat.setAudience(c.owner, { commandId: cid("aud"), name: "lint", audience: { all: true } });
    await refuses("invalid_command", () => c.deps.record(rex.p, { commandId: cid("dep"), taskId: c.ta, dependencies: toolDep(wrong) }), /not the version's digest/);
  });
  suite("second review: an audience change during a copy stops it, a restricted agent is not in a project audience, and a maintainer learns nothing of an entry it may neither change nor read", async (c) => {
    const ann = await c.agent("Ann", worker(c.a));
    const cody = await c.agent("Cody", worker(c.a), { roles: ["coder"] });
    const readme = await c.note(ann.p, "Run lint."); const code = await c.note(ann.p, "console.log('lint')");
    await c.cat.register(c.owner, { commandId: cid("pub"), name: "toolbox.lint", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: readme, executableRecordId: code, audience: { roles: ["coder"] } } as never);
    // The owner takes Cody out of the audience after the copy's first read of the entry and before its write (here: while it reads the released text back).
    let hook: (() => Promise<void>) | undefined;
    const storage = new Proxy(c.storage, { get(target, prop) {
      if (prop === "getAggregate") return async (ref: { kind: string; id: string }) => { if (hook !== undefined && ref.kind === "desk-record") { const h = hook; hook = undefined; await h(); } return target.getAggregate(ref); };
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    } });
    const racing = CatalogService.withEpoch(storage, c.epoch, c.desks, options);
    hook = async () => { await c.cat.setAudience(c.owner, { commandId: cid("aud"), name: "lint", audience: { roles: ["reviewer"] } }); };
    await refuses("not_found", () => racing.copy(cody.p, { commandId: cid("cp"), name: "lint", as: "my-lint" }), /you may read/);
    assert.equal(hook, undefined, "the audience changed during the copy");
    assert.equal(await c.cat.get(c.owner, `${personalNamespace(cody.p.id)}.my-lint`), undefined, "no copy was made");
    assert.deepEqual((await c.cat.forks(c.owner, "lint")).forks, [], "nor recorded in the lineage");
    // A project audience counts a grant only while it is usable there: a standing restriction in the project takes the agent out.
    await c.cat.setAudience(c.owner, { commandId: cid("aud"), name: "lint", audience: { projects: [c.a] } });
    assert.notEqual(await c.cat.get(ann.p, "toolbox.lint"), undefined);
    const grants = GrantService.withEpoch(c.storage, c.epoch, options);
    for (const action of ["desk.write", "desk.read"]) await grants.restrict(c.owner, { commandId: cid("rs"), subject: ann.p.id, action, project: c.a, reason: "kept out of Garden" });
    assert.equal(await c.cat.get(await ann.reauth(), "toolbox.lint"), undefined);
    const annNow = await ann.reauth();
    await refuses("not_found", () => c.cat.source(annNow, "lint"));
    // A maintainer for Orchard only, outside the Garden audience: changing it is answered as for a tool that does not exist.
    const pat = await c.agent("Pat", [{ action: "catalog.read", project: "*" }, { action: TOOLBOX_MANAGE, project: c.b }]);
    for (const p of [{ name: "lint" }, { name: "nothing-here" }]) await refuses("not_found", () => c.cat.setAudience(pat.p, { commandId: cid("aud"), name: p.name, audience: { projects: [c.b] } }), /is not a shared tool/);
    for (const name of ["toolbox.lint", "toolbox.nothing-here"]) await refuses("not_found", () => c.cat.deprecate(pat.p, { commandId: cid("dp"), name, version: "1.0.0", reason: "x" }), /is not in the catalog/);
    await refuses("not_found", () => c.cat.forks(pat.p, "lint"));
    // In the audience (a grant naming Garden) but not covering it: still refused as forbidden, as before.
    const pia = await c.agent("Pia", [{ action: "catalog.read", project: "*" }, { action: "desk.read", project: c.a }, { action: TOOLBOX_MANAGE, project: c.b }]);
    await refuses("forbidden", () => c.cat.setAudience(pia.p, { commandId: cid("aud"), name: "lint", audience: { projects: [c.b] } }), /present audience/);
    await refuses("forbidden", () => c.cat.deprecate(pia.p, { commandId: cid("dp"), name: "toolbox.lint", version: "1.0.0", reason: "x" }));
  });
}
