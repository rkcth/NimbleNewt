import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer, type Backend } from "../domain/testing/backends.js";
import { landingPolicyFrom, LANDING_SETTING_KEYS } from "../api/landing-policy.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { ConfigurationService } from "./index.js";

after(stopServer);

// Card H12u: the configuration has a PROJECT layer between the installation and the team. Only the owner writes it, it is revision-checked, a task reads the layer of its own project, and for the
// landing settings it can add protected paths and require the review permit for that project, never weaker than the installation (its built-in list and its own paths stay, the permit cannot be switched off).
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const options = { clock: () => "2026-11-12T10:00:00.000Z", pause: async () => undefined };
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const PATHS = "workspace.landing.protectedPaths", PERMIT = "workspace.landing.requirePermit", DEFAULTS = "workspace.landing.protectDefaults", BRANCH = "workspace.landing.branch";

interface Ctx { config: ConfigurationService; owner: Principal; writer: Principal; a: string; b: string; taskA: string; taskB: string; team: string; agent: string; assignments: AssignmentService }

async function open(backend: Backend, body: (c: Ctx) => Promise<void>): Promise<void> {
  const world = await backend.open();
  try {
    const projects = await ProjectService.open(world.storage, { holder: "h12u", ...options });
    const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
    const agents = AgentService.withEpoch(world.storage, projects.epoch, options);
    const config = ConfigurationService.withEpoch(world.storage, projects.epoch, options);
    const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const a = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
    const b = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "B" })).id;
    const taskA = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: a, title: "ta" })).id;
    const taskB = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: b, title: "tb" })).id;
    const team = (await agents.createTeam(owner, { commandId: cid("tm"), name: "builders" })).id;
    const agent = (await agents.create(owner, { commandId: cid("a"), friendlyName: "A", teamId: team })).id;
    await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "writer", grants: [{ action: "config.write", project: "*" }] });
    const writer = await principals.authenticate((await principals.issueCredential(owner, "agent:writer")).token);
    await body({ config, owner, writer, a, b, taskA, taskB, team, agent, assignments });
  } finally { await world.close(); }
}

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) => test(`${backend.name}: ${name}`, () => open(backend, body));
  /** Sets and removes settings of one layer in force in one write, at the revision the layer is at (0 when it does not exist). */
  const change = async (c: Ctx, who: Principal, layer: "installation" | "project" | "team" | "agent" | "task", scopeId: string | undefined, set: Record<string, unknown>, remove: string[] = []) => {
    const existing = await c.config.layer(c.owner, layer, scopeId);
    return c.config.change(who, { commandId: cid("ch"), layer, ...(scopeId === undefined ? {} : { scopeId }), expectedRevision: existing?.revision ?? 0, ...(Object.keys(set).length === 0 ? {} : { set }), ...(remove.length === 0 ? {} : { remove }) });
  };
  const keys = Object.values(LANDING_SETTING_KEYS);

  suite("only the owner writes a project layer, it is revision-checked, and a project that does not exist or a malformed ID is refused", async (c) => {
    await refuses("forbidden", () => change(c, c.writer, "project", c.a, { [PATHS]: ["x/"] }), (e) => assert.match(e.message, /only the owner/));
    await refuses("forbidden", () => c.config.stage(c.writer, { commandId: cid("st"), layer: "project", scopeId: c.a, set: { [PATHS]: ["x/"] } }));
    assert.equal(await c.config.layer(c.owner, "project", c.a), undefined, "nothing was written");
    await refuses("not_found", () => change(c, c.owner, "project", "proj-zzzzzzzzzzzzzzzzzzzz", { [PATHS]: ["x/"] }));
    await refuses("invalid_command", () => change(c, c.owner, "project", "../x", { [PATHS]: ["x/"] }), (e) => assert.match(e.message, /not a project ID/));
    await refuses("invalid_command", () => c.config.change(c.owner, { commandId: cid("ch"), layer: "project", set: { [PATHS]: ["x/"] } } as never), (e) => assert.match(e.message, /scopeId/));
    const first = await change(c, c.owner, "project", c.a, { [PATHS]: ["ci/"] });
    assert.equal(first.revision, 1);
    // Revision-checked: a write at a revision the layer has moved past is stale, a write at the right one goes through.
    await refuses("stale_revision", () => c.config.change(c.owner, { commandId: cid("ch"), layer: "project", scopeId: c.a, expectedRevision: 0, set: { [PATHS]: ["y/"] } }));
    const second = await c.config.change(c.owner, { commandId: cid("ch"), layer: "project", scopeId: c.a, expectedRevision: 1, set: { [PATHS]: ["ci/", "docs/"] } });
    assert.equal(second.revision, 2);
    assert.deepEqual((await c.config.layer(c.owner, "project", c.a))!.applied[PATHS]!.value, ["ci/", "docs/"]);
    assert.equal((await c.config.layer(c.owner, "project", c.a))!.history.at(-1)!.by, c.owner.id);
  });

  suite("a task reads its own project's layer between the installation and the team; another project's layer does not reach it", async (c) => {
    await change(c, c.owner, "installation", undefined, { [PATHS]: ["inst/"] });
    await change(c, c.owner, "project", c.a, { [PATHS]: ["a-only/"] });
    await change(c, c.owner, "project", c.b, { [PATHS]: ["b-only/"] });
    await change(c, c.owner, "team", c.team, { [PATHS]: ["team/"] });
    const forTask = async (taskId: string) => (await c.config.taskValues([PATHS], taskId))![PATHS];
    assert.deepEqual(await forTask(c.taskA), ["a-only/", "inst/"]);
    assert.deepEqual(await forTask(c.taskB), ["b-only/", "inst/"]);
    // With an agent working the task its team's layer is added, and the value names every layer's paths.
    await c.assignments.assignTask({ commandId: cid("as"), actor: c.owner.id, taskId: c.taskA, owner: { kind: "agent", id: c.agent } });
    assert.deepEqual(await forTask(c.taskA), ["a-only/", "inst/", "team/"]);
    const eff = (await c.config.effective(c.owner, { taskId: c.taskA }))!;
    assert.deepEqual(eff.values[PATHS]!.value, ["a-only/", "inst/", "team/"]);
    assert.equal(eff.values[PATHS]!.source.layer, "team", "the layer that last added to the list");
    // A project asked about alone: the installation and that project.
    const alone = (await c.config.effective(c.owner, { projectId: c.b }))!;
    assert.deepEqual(alone.values[PATHS]!.value, ["b-only/", "inst/"]);
    assert.deepEqual((await c.config.projectValues([PATHS], c.a))[PATHS], ["a-only/", "inst/"]);
    // A project that has no layer is the installation's; a task asked about with the wrong project throws, nothing is guessed.
    const fresh = await c.config.projectValues([PATHS], "proj-zzzzzzzzzzzzzzzzzzzz");
    assert.deepEqual(fresh[PATHS], ["inst/"]);
    await refuses("invalid_command", () => c.config.taskValues([PATHS], c.taskA, c.b), (e) => assert.match(e.message, /is not a task of/));
    assert.deepEqual((await c.config.taskValues([PATHS], c.taskB, c.b))![PATHS], ["b-only/", "inst/"]);
  });

  suite("a project's list is never weaker than the installation's: the installation's paths stay, the built-in list and the branch stay the installation's, the permit can be required but not switched off", async (c) => {
    await change(c, c.owner, "installation", undefined, { [PATHS]: ["inst/"], [BRANCH]: "main" });
    // The built-in list and the branch are installation-wide: a project layer cannot give them.
    await refuses("invalid_command", () => change(c, c.owner, "project", c.a, { [DEFAULTS]: false }), (e) => assert.match(e.message, /can only be set for the whole installation/));
    await refuses("invalid_command", () => change(c, c.owner, "project", c.a, { [BRANCH]: "evil" }), (e) => assert.match(e.message, /can only be set for the whole installation/));
    // A project's list replaces only the project's own entries: the installation's stay in force whatever the project says.
    await change(c, c.owner, "project", c.a, { [PATHS]: ["ci/"] });
    await change(c, c.owner, "project", c.a, { [PATHS]: [] });
    assert.deepEqual((await c.config.taskValues([PATHS], c.taskA))![PATHS], ["inst/"], "an empty project list takes nothing off the installation's");
    // A stored project value for an installation-only setting (written before it was) does not count.
    // The permit: required by default, so a project cannot turn it off; the installation turning it off lets a project require it again.
    await refuses("invalid_command", () => change(c, c.owner, "project", c.a, { [PERMIT]: false }), (e) => assert.match(e.message, /wider than the layers above allow/));
    await change(c, c.owner, "installation", undefined, { [PERMIT]: false });
    assert.equal((await c.config.taskValues([PERMIT], c.taskA))![PERMIT], false, "the installation's explicit false");
    await change(c, c.owner, "project", c.a, { [PERMIT]: true });
    assert.equal((await c.config.taskValues([PERMIT], c.taskA))![PERMIT], true, "project A requires it");
    assert.equal((await c.config.taskValues([PERMIT], c.taskB))![PERMIT], false, "project B follows the installation");
    // A task cannot switch off what its project requires, even though the installation does not.
    await refuses("invalid_command", () => change(c, c.owner, "task", c.taskA, { [PERMIT]: false }), (e) => assert.match(e.message, /wider than the layers above allow/));
    // Switching the installation back on keeps the project's requirement (a restriction meets to the tighter value).
    await change(c, c.owner, "installation", undefined, { [PERMIT]: true });
    assert.equal((await c.config.taskValues([PERMIT], c.taskA))![PERMIT], true);
    const eff = (await c.config.effective(c.owner, { projectId: c.a }))!;
    assert.deepEqual(eff.values[DEFAULTS]!.source, { layer: "default", id: "default" }, "the built-in list is still on");
  });

  suite("the landing policy a host reads follows the task's project: its paths and permit, its own branch over the installation's, and a project asked about by a task of another project is refused", async (c) => {
    await change(c, c.owner, "installation", undefined, { [BRANCH]: "main", [PATHS]: ["inst/"], [PERMIT]: false });
    await change(c, c.owner, "project", c.b, { [PATHS]: ["b-only/"], [PERMIT]: true });
    const policy = landingPolicyFrom(c.config, async (projectId) => (projectId === c.b ? "trunk" : undefined));
    assert.deepEqual(await policy({ taskId: c.taskA, projectId: c.a }), { branch: "main", requirePermit: false, protectDefaults: true, protectedPaths: ["inst/"] });
    assert.deepEqual(await policy({ taskId: c.taskB, projectId: c.b }), { branch: "trunk", requirePermit: true, protectDefaults: true, protectedPaths: ["b-only/", "inst/"] });
    // A task the configuration does not know is read at the installation and the named project's layers (not the installation alone).
    assert.deepEqual(await policy({ taskId: "task-zzzzzzzzzzzzzzzzzzzz", projectId: c.b }), { branch: "trunk", requirePermit: true, protectDefaults: true, protectedPaths: ["b-only/", "inst/"] });
    assert.deepEqual(await policy({ taskId: "task-zzzzzzzzzzzzzzzzzzzz", projectId: c.a }), { branch: "main", requirePermit: false, protectDefaults: true, protectedPaths: ["inst/"] });
    await assert.rejects(() => policy({ taskId: c.taskA, projectId: c.b }), /is not a task of/, "fail closed: the order names a project the task is not in");
    // Read fresh at each call: a change counts from the next landing.
    await change(c, c.owner, "project", c.b, { [PATHS]: ["b-only/", "more/"] });
    assert.deepEqual((await policy({ taskId: c.taskB, projectId: c.b })).protectedPaths, ["b-only/", "inst/", "more/"]);
  });

  suite("the projects that have values of their own are listed with each value, where it comes from and the project's own value", async (c) => {
    await change(c, c.owner, "installation", undefined, { [PATHS]: ["inst/"] });
    await change(c, c.owner, "project", c.b, { [PATHS]: ["b-only/"] });
    await change(c, c.owner, "project", c.a, { "time.checkpointMinutes": 5 });
    const found = await c.config.projectSettings(keys, []);
    assert.deepEqual(found.projects.map((p) => p.projectId), [c.b], "a project whose layer sets none of these keys is not listed");
    assert.deepEqual(found.projects[0]!.values[PATHS], { value: ["b-only/", "inst/"], source: { layer: "project", id: c.b }, own: ["b-only/"] });
    assert.deepEqual(found.projects[0]!.values[PERMIT]!.source, { layer: "default", id: "default" });
    assert.equal(found.truncated, false);
    // A project that only has its own landing branch can be listed too, and the list is capped.
    const more = await c.config.projectSettings(keys, [c.a, c.b], 1);
    assert.equal(more.projects.length, 1);
    assert.equal(more.truncated, true);
    const withBranch = await c.config.projectSettings(keys, [c.a]);
    assert.deepEqual(withBranch.projects.map((p) => p.projectId).sort(), [c.a, c.b].sort());
  });
}
