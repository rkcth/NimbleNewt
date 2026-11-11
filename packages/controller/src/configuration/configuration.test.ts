import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer, type Backend } from "../domain/testing/backends.js";
import { RoutingService } from "../routing/index.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { landingPolicyFrom } from "../api/landing-policy.js";
import { ConfigurationService, type LayerKind, type SettingDefinition } from "./index.js";
import type { ControllerStorage, OperationInput } from "../storage/types.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

interface Ctx {
  storage: ControllerStorage; epoch: number;
  config: ConfigurationService; routing: RoutingService; owner: Principal; grants: GrantService; assignments: AssignmentService; projects: ProjectService;
  later: (settings: readonly SettingDefinition[]) => ConfigurationService;
  team: string; agentA: string; agentB: string; task: string; project: string;
  writer: Principal; broad: Principal; routingWriter: Principal; nobody: Principal; agentPrincipal: Principal; otherAgentPrincipal: Principal;
}

async function open(backend: Backend, body: (c: Ctx) => Promise<void>): Promise<void> {
  const world = await backend.open();
  try {
    const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
    const agents = AgentService.withEpoch(world.storage, projects.epoch, options);
    const routing = RoutingService.withEpoch(world.storage, projects.epoch, options);
    const config = ConfigurationService.withEpoch(world.storage, projects.epoch, { ...options, routing });
    const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
    const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
    const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
    const team = (await agents.createTeam(owner, { commandId: cid("tm"), name: "builders" })).id;
    const agentA = (await agents.create(owner, { commandId: cid("a"), friendlyName: "A", teamId: team })).id;
    const agentB = (await agents.create(owner, { commandId: cid("a"), friendlyName: "B" })).id;
    const plain = async (nm: string, g: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
    const as = async (id: string) => principals.authenticate((await principals.issueCredential(owner, `agent:${id}`)).token);
    await body({
      later: (settings) => ConfigurationService.withEpoch(world.storage, projects.epoch, { ...options, routing, settings }),
      storage: world.storage, epoch: projects.epoch,
      config, routing, owner, grants, assignments, projects, team, agentA, agentB, task, project,
      writer: await plain("writer", [{ action: "config.write", project: "*" }]), routingWriter: await plain("rw", [{ action: "routing.write", project: "*" }]),
      broad: await plain("broad", [{ action: "*", project: "*" }]), nobody: await plain("nobody", []), agentPrincipal: await as(agentA), otherAgentPrincipal: await as(agentB),
    });
  } finally { await world.close(); }
}

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) => test(`${backend.name}: ${name}`, () => open(backend, body));
  /** Stages and applies in one go; returns the apply result. */
  const put = async (c: Ctx, who: Principal, layer: LayerKind, scopeId: string | undefined, set: Record<string, unknown>, extra: { lock?: string[]; unlock?: string[]; remove?: string[] } = {}) => {
    const id = layer === "installation" ? "installation" : `${layer}/${scopeId}`;
    const existing = await c.config.layer(c.owner, layer, scopeId);
    void id;
    const staged = await c.config.stage(who, { commandId: cid("st"), layer, ...(scopeId === undefined ? {} : { scopeId }), ...(existing === undefined ? {} : { expectedRevision: existing.revision }), set, ...extra });
    return c.config.apply(who, { commandId: cid("ap"), layer, ...(scopeId === undefined ? {} : { scopeId }), expectedRevision: staged.revision });
  };
  /** Stages against the layer's current revision, for tests that expect the staging itself to be refused. */
  const stageNow = async (c: Ctx, who: Principal, layer: LayerKind, scopeId: string | undefined, extra: Record<string, unknown>) => {
    const existing = await c.config.layer(c.owner, layer, scopeId);
    return c.config.stage(who, { commandId: cid("st"), layer, ...(scopeId === undefined ? {} : { scopeId }), ...(existing === undefined ? {} : { expectedRevision: existing.revision }), ...extra } as never);
  };
  const value = async (c: Ctx, key: string, scope: { agentId?: string; taskId?: string } = {}) => (await c.config.effective(c.owner, scope))!.values[key];

  suite("a more specific layer overrides a default setting; each value names its source layer", async (c) => {
    assert.deepEqual((await value(c, "workClass.pcFloor"))!.source, { layer: "default", id: "default" });
    await put(c, c.owner, "installation", undefined, { "workClass.pcFloor": 10 });
    await put(c, c.owner, "team", c.team, { "workClass.pcFloor": 20 });
    await put(c, c.owner, "agent", c.agentA, { "workClass.pcFloor": 30 });
    await put(c, c.owner, "task", c.task, { "workClass.pcFloor": 40 });
    const at = async (scope: { agentId?: string; taskId?: string }) => { const v = (await value(c, "workClass.pcFloor", scope))!; return [v.value, v.source.layer, v.source.id]; };
    assert.deepEqual(await at({}), [10, "installation", "installation"]);
    assert.deepEqual(await at({ agentId: c.agentA }), [30, "agent", c.agentA]);
    assert.deepEqual(await at({ agentId: c.agentA, taskId: c.task }), [40, "task", c.task]);
    // An agent in no team skips the team layer.
    assert.deepEqual(await at({ agentId: c.agentB }), [10, "installation", "installation"]);
    assert.equal((await value(c, "workClass.pcFloor", { agentId: c.agentA }))!.effect, "next-request");
  });

  suite("the landing policy is a set of real settings: branch, permit requirement (only tightened) and protected paths are checked and chat-settable (card H12q re-review)", async (c) => {
    await put(c, c.owner, "installation", undefined, { "workspace.landing.branch": "main", "workspace.landing.protectedPaths": ["docs/", ".github/", "CODEOWNERS"] });
    assert.equal((await value(c, "workspace.landing.branch"))!.value, "main");
    assert.deepEqual((await value(c, "workspace.landing.protectedPaths"))!.value, [".github/", "CODEOWNERS", "docs/"]);
    assert.equal((await value(c, "workspace.landing.requirePermit"))!.value, true, "the permit is required unless someone turns it off");
    await refuses("invalid_command", () => stageNow(c, c.owner, "installation", undefined, { set: { "workspace.landing.branch": "../x" } }), (e) => assert.match(e.message, /branch name/));
    await refuses("invalid_command", () => stageNow(c, c.owner, "installation", undefined, { set: { "workspace.landing.protectedPaths": ["../etc"] } }), (e) => assert.match(e.message, /path pattern/));
    // Once the installation requires it, a task cannot turn the requirement off.
    await put(c, c.owner, "installation", undefined, { "workspace.landing.requirePermit": true });
    await refuses("invalid_command", () => stageNow(c, c.owner, "task", c.task, { set: { "workspace.landing.requirePermit": false } }), (e) => assert.match(e.message, /wider than the layers above allow|can only narrow/));
  });

  suite("landing: only the owner can turn the permit requirement off; lower layers can only keep it on; the policy reads the real service per task (card H12s review)", async (c) => {
    const policy = landingPolicyFrom(c.config);
    const call = { taskId: c.task, projectId: c.project };
    assert.equal((await policy(call)).requirePermit, true);
    assert.equal((await value(c, "workspace.landing.requirePermit"))!.value, true, "the default view shows true");
    // Nobody but the owner writes the installation layer, and with nothing set a task cannot turn it off either.
    await refuses("forbidden", () => stageNow(c, c.writer, "installation", undefined, { set: { "workspace.landing.requirePermit": false } }));
    await refuses("invalid_command", () => stageNow(c, c.owner, "task", c.task, { set: { "workspace.landing.requirePermit": false } }), (e) => assert.match(e.message, /wider than the layers above allow/));
    await refuses("invalid_command", () => stageNow(c, c.writer, "task", c.task, { set: { "workspace.landing.requirePermit": false } }));
    await put(c, c.owner, "installation", undefined, { "workspace.landing.requirePermit": false });
    assert.equal((await policy(call)).requirePermit, false, "the owner's explicit false is what the host reads");
    assert.equal((await value(c, "workspace.landing.requirePermit", { taskId: c.task }))!.value, false);
    // A task can tighten it again, and then the task value wins.
    await put(c, c.writer, "task", c.task, { "workspace.landing.requirePermit": true });
    assert.equal((await policy(call)).requirePermit, true, "task layer over installation");
    // The owner turns it on again.
    await put(c, c.owner, "installation", undefined, { "workspace.landing.requirePermit": true });
    await refuses("invalid_command", () => stageNow(c, c.owner, "agent", c.agentA, { set: { "workspace.landing.requirePermit": false } }), (e) => assert.match(e.message, /wider than the layers above allow/));
  });

  suite("landing: the owner's protected paths add to the built-in list, every layer adds, the built-in list is switched off only by the owner, and the branch is the owner's alone (card H12s review)", async (c) => {
    const policy = landingPolicyFrom(c.config);
    const call = { taskId: c.task, projectId: c.project };
    assert.deepEqual(await policy(call), { requirePermit: true, protectDefaults: true, protectedPaths: [] });
    await put(c, c.owner, "installation", undefined, { "workspace.landing.protectedPaths": ["docs/"], "workspace.landing.branch": "main" });
    await put(c, c.writer, "task", c.task, { "workspace.landing.protectedPaths": ["secrets/"] });
    assert.deepEqual((await policy(call)).protectedPaths, ["docs/", "secrets/"], "layers add; nothing is replaced");
    assert.equal((await policy(call)).protectDefaults, true);
    // Not widening: a task cannot take a path away, nor change the branch, nor switch the defaults off.
    await put(c, c.writer, "task", c.task, { "workspace.landing.protectedPaths": [] });
    assert.deepEqual((await policy(call)).protectedPaths, ["docs/"], "an empty task list adds nothing and removes nothing");
    await refuses("invalid_command", () => stageNow(c, c.writer, "task", c.task, { set: { "workspace.landing.branch": "evil" } }), (e) => assert.match(e.message, /whole installation/));
    await refuses("invalid_command", () => stageNow(c, c.owner, "agent", c.agentA, { set: { "workspace.landing.branch": "evil" } }), (e) => assert.match(e.message, /whole installation/));
    await refuses("invalid_command", () => stageNow(c, c.writer, "task", c.task, { set: { "workspace.landing.protectDefaults": false } }), (e) => assert.match(e.message, /whole installation/));
    await refuses("forbidden", () => stageNow(c, c.writer, "installation", undefined, { set: { "workspace.landing.protectDefaults": false } }));
    assert.equal((await policy(call)).branch, "main");
    await put(c, c.owner, "installation", undefined, { "workspace.landing.protectDefaults": false });
    assert.equal((await policy(call)).protectDefaults, false, "the owner switched the built-in list off");
    assert.deepEqual((await policy(call)).protectedPaths, ["docs/"]);
    // Patterns with a . part never match anything: refused.
    for (const bad of ["./CODEOWNERS", ".github/./", "a/./b", "/etc"]) await refuses("invalid_command", () => stageNow(c, c.owner, "installation", undefined, { set: { "workspace.landing.protectedPaths": [bad] } }), (e) => assert.match(e.message, /path pattern/));
    // The task-layer value on a task that exists is read for that task (not the unknown-task fallback).
    await put(c, c.owner, "task", c.task, { "workspace.landing.protectedPaths": ["only-here/"] });
    assert.deepEqual((await policy(call)).protectedPaths, ["docs/", "only-here/"]);
    assert.deepEqual((await policy({ taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: c.project })).protectedPaths, ["docs/"], "an unknown task reads the installation value");
  });

  suite("landing: a value stored in a task layer before the setting became installation-only is ignored when reading, and listed as ignored (card H12s second review)", async (c) => {
    // The same key as it was defined before: a plain default, so a task layer could hold it; then the key is made installation-only.
    const legacy = c.later([{ key: "test.legacy.branch", kind: "default", check: (v) => v, effect: "next-request", description: "d" }]);
    const staged = await legacy.stage(c.owner, { commandId: cid("st"), layer: "task", scopeId: c.task, set: { "test.legacy.branch": "evil" } } as never);
    assert.equal((await legacy.apply(c.owner, { commandId: cid("ap"), layer: "task", scopeId: c.task, expectedRevision: staged.revision } as never)).applied, true);
    assert.equal(await legacy.taskValue("test.legacy.branch", c.task), "evil", "before the change the task layer wins");
    const now = c.later([{ key: "test.legacy.branch", kind: "default", installationOnly: true, check: (v) => v, effect: "next-request", description: "d" }]);
    assert.equal(await now.taskValue("test.legacy.branch", c.task), undefined, "the stale task value no longer wins");
    const staged2 = await now.stage(c.owner, { commandId: cid("st"), layer: "installation", set: { "test.legacy.branch": "main" } } as never);
    await now.apply(c.owner, { commandId: cid("ap"), layer: "installation", expectedRevision: staged2.revision } as never);
    assert.equal(await now.taskValue("test.legacy.branch", c.task), "main");
    const eff = (await now.effective(c.owner, { taskId: c.task }))!.values["test.legacy.branch"]!;
    assert.deepEqual(eff.ignored.map((i) => [i.layer, i.id]), [["task", c.task]]);
    assert.match(eff.ignored[0]!.reason, /whole installation/);
    // One combination answers all keys.
    assert.deepEqual(await now.taskValues(["test.legacy.branch", "no.such"], c.task), { "test.legacy.branch": "main", "no.such": undefined });
    assert.equal(await now.taskValues(["test.legacy.branch"], "task-aaaaaaaaaaaaaaaaaaaa"), undefined);
    // The setting list exposes the flags for the chat text.
    const flags = Object.fromEntries(c.config.settings().filter((s) => s.key.startsWith("workspace.landing.")).map((s) => [s.key, [s.installationOnly === true, s.installationMayWiden === true]]));
    assert.deepEqual(flags, { "workspace.landing.branch": [true, false], "workspace.landing.requirePermit": [false, true], "workspace.landing.protectedPaths": [false, false], "workspace.landing.protectDefaults": [true, false] });
  });

  suite("a restriction can only be narrowed: a task cannot re-enable a disabled provider or raise a ceiling, now or after the layer above changes", async (c) => {
    await put(c, c.owner, "installation", undefined, { "provider.openrouter.enabled": false, "time.maxMinutes": 120 });
    await refuses("invalid_command", () => stageNow(c, c.owner, "task", c.task, { set: { "provider.openrouter.enabled": true } }), (e) => assert.match(e.message, /wider than the layers above allow/));
    await refuses("invalid_command", () => stageNow(c, c.owner, "agent", c.agentA, { set: { "time.maxMinutes": 500 } }), (e) => assert.match(e.message, /can only narrow/));
    await put(c, c.owner, "agent", c.agentA, { "time.maxMinutes": 60, "provider.openrouter.enabled": false });
    assert.deepEqual([(await value(c, "time.maxMinutes", { agentId: c.agentA }))!.value, (await value(c, "time.maxMinutes", { agentId: c.agentA }))!.source.layer], [60, "agent"]);
    // The task layer was checked against the installation only (it does not know the agent), so 90 is accepted there, and the resolver still keeps the tighter 60.
    await put(c, c.owner, "task", c.task, { "time.maxMinutes": 90 });
    const both = (await value(c, "time.maxMinutes", { agentId: c.agentA, taskId: c.task }))!;
    assert.deepEqual([both.value, both.source.layer], [60, "agent"]);
    assert.deepEqual(both.ignored.map((i) => [i.layer, i.reason]), [["task", "wider than the layers above allow"]]);
    // Loosen the installation layer, tighten a task: allowed. Then tighten the installation below the task's value: the task's value stops counting.
    await put(c, c.owner, "installation", undefined, { "time.maxMinutes": 30 });
    assert.equal((await value(c, "time.maxMinutes", { taskId: c.task }))!.value, 30);
    // The controller's own reading for a task (the dispatcher's claim) sees the same combined value, and nothing for a key that is unset or a bad ID.
    assert.equal(await c.config.taskValue("time.maxMinutes", c.task), 30);
    assert.equal(await c.config.taskValue("time.maxMinutes", "task-aaaaaaaaaaaaaaaaaaaa"), undefined);
    assert.equal(await c.config.taskValue("time.maxMinutes", "nope"), undefined);
    assert.equal(await c.config.taskValue("budget.maxCostPerTask", c.task), undefined, "the unenforced cost key was removed");
    // A list restriction narrows by intersection, and a wider list is refused.
    await put(c, c.owner, "installation", undefined, { "permissions.allowedTools": ["read-file", "run-script", "search"] });
    await refuses("invalid_command", () => stageNow(c, c.owner, "agent", c.agentA, { set: { "permissions.allowedTools": ["read-file", "deploy"] } }));
    await put(c, c.owner, "agent", c.agentA, { "permissions.allowedTools": ["search", "read-file"] });
    assert.deepEqual((await value(c, "permissions.allowedTools", { agentId: c.agentA }))!.value, ["read-file", "search"]);
  });

  suite("a lock stops the layers below changing a setting, whether it was set before or after the lock", async (c) => {
    await put(c, c.owner, "team", c.team, { "workClass.pcCeiling": 70 });
    await put(c, c.owner, "installation", undefined, { "workClass.pcCeiling": 90 }, { lock: ["workClass.pcCeiling"] });
    await refuses("invalid_command", () => stageNow(c, c.owner, "agent", c.agentA, { set: { "workClass.pcCeiling": 50 } }), (e) => assert.match(e.message, /locked by the installation layer/));
    const v = (await value(c, "workClass.pcCeiling", { agentId: c.agentA }))!;
    assert.deepEqual([v.value, v.source.layer, v.lockedBy?.layer, v.ignored.map((i) => i.layer)], [90, "installation", "installation", ["team"]]);
    assert.match(v.ignored[0]!.reason, /locked by the installation layer/);
    // Unlocking lets the team's own value count again.
    const layer = (await c.config.layer(c.owner, "installation"))!;
    const staged = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", expectedRevision: layer.revision, unlock: ["workClass.pcCeiling"] });
    await c.config.apply(c.owner, { commandId: cid("ap"), layer: "installation", expectedRevision: staged.revision });
    assert.equal((await value(c, "workClass.pcCeiling", { agentId: c.agentA }))!.value, 70);
  });

  suite("a denial can only grow: no layer can take a tool off a list a layer above set", async (c) => {
    await put(c, c.owner, "installation", undefined, { "permissions.deniedTools": ["shell.rm"] });
    const wiped = await put(c, c.writer, "task", c.task, { "permissions.deniedTools": [] });
    assert.equal(wiped.applied, true);
    assert.deepEqual((await value(c, "permissions.deniedTools", { taskId: c.task }))!.value, ["shell.rm"]);
    await put(c, c.writer, "agent", c.agentA, { "permissions.deniedTools": ["net.fetch"] });
    await put(c, c.writer, "task", c.task, { "permissions.deniedTools": ["db.drop"] });
    const effective = (await value(c, "permissions.deniedTools", { agentId: c.agentA, taskId: c.task }))!;
    assert.deepEqual(effective.value, ["db.drop", "net.fetch", "shell.rm"]);
    // Taking the installation's tool off at the installation itself is the owner's call.
    await put(c, c.owner, "installation", undefined, { "permissions.deniedTools": [] });
    assert.deepEqual((await value(c, "permissions.deniedTools", { agentId: c.agentA, taskId: c.task }))!.value, ["db.drop", "net.fetch"]);
  });

  suite("a task is judged with the agent working it: its team and agent limits apply to what it sets, and reading it alone finds that agent", async (c) => {
    await c.projects.transitionTask({ commandId: cid("tr"), actor: c.owner.id, taskId: c.task, expectedRevision: 1, to: "ready" });
    await put(c, c.owner, "team", c.team, { "time.maxMinutes": 10 });
    // Nobody works the task yet: it is checked against the installation only, and reading it says it is incomplete.
    const early = await c.config.effective(c.owner, { taskId: c.task });
    assert.equal(early!.complete, false);
    await c.assignments.assignTask({ commandId: cid("as"), actor: c.owner.id, taskId: c.task, owner: { kind: "agent", id: c.agentA } });
    const alone = (await c.config.effective(c.owner, { taskId: c.task }))!;
    assert.deepEqual([alone.complete, alone.values["time.maxMinutes"]!.value, alone.values["time.maxMinutes"]!.source.layer], [true, 10, "team"]);
    // The task's own checkpoint interval does not fit the team's ten-minute limit, and a task value wider than the team allows is refused at once.
    const bad = await put(c, c.owner, "task", c.task, { "time.checkpointMinutes": 20 });
    assert.ok(!bad.applied && bad.problems.some((p) => /first checkpoint/.test(p)), bad.problems.join("; "));
    await refuses("invalid_command", () => stageNow(c, c.owner, "task", c.task, { set: { "time.maxMinutes": 30 } }), (e) => assert.match(e.message, /wider than the layers above allow/));
    // A lock at the team layer reaches the task too.
    await put(c, c.owner, "team", c.team, { "workClass.pcFloor": 5 }, { lock: ["workClass.pcFloor"] });
    await refuses("invalid_command", () => stageNow(c, c.owner, "task", c.task, { set: { "workClass.pcFloor": 9 } }), (e) => assert.match(e.message, /locked by the team layer/));
  });

  suite("a repeated apply answers with what that apply did, however much has happened since", async (c) => {
    const first = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", set: { "budget.paidAllowed": false } });
    const commandId = cid("ap");
    const done = await c.config.apply(c.owner, { commandId, layer: "installation", expectedRevision: first.revision });
    // A later draft that fails to apply, then another that succeeds.
    const bad = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", expectedRevision: done.revision, set: { "workClass.pcFloor": 90, "workClass.pcCeiling": 10 } });
    const failCommand = cid("ap");
    const failed = await c.config.apply(c.owner, { commandId: failCommand, layer: "installation", expectedRevision: bad.revision });
    assert.equal(failed.applied, false);
    const fix = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", expectedRevision: failed.revision, set: { "workClass.pcFloor": 1, "workClass.pcCeiling": 10 } });
    const later = await c.config.apply(c.owner, { commandId: cid("ap"), layer: "installation", expectedRevision: fix.revision });
    assert.equal(later.applied, true);
    const again = await c.config.apply(c.owner, { commandId, layer: "installation", expectedRevision: first.revision });
    assert.deepEqual([again.applied, again.takesEffect, again.revision], [true, { "budget.paidAllowed": "next-request" }, done.revision]);
    const againFailed = await c.config.apply(c.owner, { commandId: failCommand, layer: "installation", expectedRevision: bad.revision });
    assert.deepEqual([againFailed.applied, againFailed.problems, againFailed.revision], [false, failed.problems, failed.revision]);
  });

  suite("a restriction set to the value it already has is still credited to the layer that set it; the pause switch cannot be turned off", async (c) => {
    await put(c, c.owner, "installation", undefined, { "provider.x.enabled": true });
    assert.equal((await value(c, "provider.x.enabled"))!.source.layer, "installation");
    await refuses("invalid_command", () => stageNow(c, c.owner, "installation", undefined, { set: { "lifecycle.reloadPreservesPause": false } }), (e) => assert.match(e.message, /must stay true/));
    await put(c, c.owner, "installation", undefined, { "lifecycle.reloadPreservesPause": true });
  });

  suite("a staged change is not in force until applied; the history shows who, what and when it starts to count; a repeat answers the same", async (c) => {
    const staged = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", set: { "budget.paidAllowed": false, "time.maxMinutes": 45 } });
    assert.equal((await value(c, "budget.paidAllowed"))!.value, true, "a draft is not in force");
    const view = (await c.config.layer(c.owner, "installation"))!;
    assert.deepEqual([Object.keys(view.draft!.set).sort(), view.applied], [["budget.paidAllowed", "time.maxMinutes"], {}]);
    await refuses("stale_revision", () => c.config.apply(c.owner, { commandId: cid("ap"), layer: "installation", expectedRevision: staged.revision + 4 }));
    const commandId = cid("ap");
    const result = await c.config.apply(c.owner, { commandId, layer: "installation", expectedRevision: staged.revision });
    assert.deepEqual([result.applied, result.takesEffect], [true, { "budget.paidAllowed": "next-request", "time.maxMinutes": "after-current-operation" }]);
    assert.equal((await value(c, "budget.paidAllowed"))!.value, false);
    const again = await c.config.apply(c.owner, { commandId, layer: "installation", expectedRevision: staged.revision });
    assert.deepEqual([again.applied, again.takesEffect], [true, result.takesEffect]);
    const history = (await c.config.history(c.owner, "installation"))!;
    assert.deepEqual(history.map((h) => [h.by, [...h.set].sort(), h.revision]), [["owner:rob", ["budget.paidAllowed", "time.maxMinutes"], result.revision]]);
    // Discarding throws a draft away; there must be one.
    const next = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", expectedRevision: result.revision, set: { "time.maxMinutes": 10 } });
    await c.config.discard(c.owner, { commandId: cid("dc"), layer: "installation", expectedRevision: next.revision });
    assert.equal((await c.config.layer(c.owner, "installation"))!.draft, undefined);
    await refuses("invalid_command", () => c.config.discard(c.owner, { commandId: cid("dc"), layer: "installation", expectedRevision: next.revision + 1 }), (e) => assert.match(e.message, /nothing staged/));
    // Removing a setting returns it to the layer above or the default.
    const l = (await c.config.layer(c.owner, "installation"))!;
    const s2 = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", expectedRevision: l.revision, remove: ["budget.paidAllowed"] });
    await c.config.apply(c.owner, { commandId: cid("ap"), layer: "installation", expectedRevision: s2.revision });
    assert.equal((await value(c, "budget.paidAllowed"))!.source.layer, "default");
  });

  suite("a combination that does not fit is refused as a whole: nothing changes in force, the reason is kept, and the draft stays to be corrected", async (c) => {
    await put(c, c.owner, "installation", undefined, { "workClass.pcCeiling": 60 });
    const before = (await c.config.layer(c.owner, "installation"))!;
    const staged = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", expectedRevision: before.revision, set: { "workClass.pcFloor": 80, "workClass.pcTarget": 95 } });
    const failed = await c.config.apply(c.owner, { commandId: cid("ap"), layer: "installation", expectedRevision: staged.revision });
    assert.equal(failed.applied, false);
    assert.ok(failed.problems.some((p) => /pcFloor \(80\) is above workClass.pcCeiling \(60\)/.test(p)), failed.problems.join("; "));
    assert.ok(failed.problems.some((p) => /pcTarget \(95\) is outside/.test(p)));
    const after = (await c.config.layer(c.owner, "installation"))!;
    assert.deepEqual([after.applied, Object.keys(after.draft!.set).sort(), after.lastFailure?.problems.length], [before.applied, ["workClass.pcFloor", "workClass.pcTarget"], failed.problems.length]);
    assert.equal((await value(c, "workClass.pcFloor"))!.source.layer, "default");
    // Correct the draft and apply: it goes in and the failure record clears.
    const fixed = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", expectedRevision: after.revision, set: { "workClass.pcFloor": 20, "workClass.pcTarget": 40 } });
    assert.equal((await c.config.apply(c.owner, { commandId: cid("ap"), layer: "installation", expectedRevision: fixed.revision })).applied, true);
    assert.equal((await c.config.layer(c.owner, "installation"))!.lastFailure, undefined);
    // Other impossible combinations.
    const tools = await put(c, c.owner, "agent", c.agentA, { "permissions.allowedTools": ["run-script"], "permissions.deniedTools": ["run-script"] });
    assert.ok(!tools.applied && tools.problems.some((p) => /both allowed and denied/.test(p)) && tools.problems.some((p) => /no tool could be used/.test(p)));
    const circle = await put(c, c.owner, "team", c.team, { "routing.fallbackProfile.fast": "slow", "routing.fallbackProfile.slow": "fast" });
    assert.ok(!circle.applied && circle.problems.some((p) => /go round in a circle/.test(p)));
    const impossible = await put(c, c.owner, "agent", c.agentB, { "time.maxMinutes": 20, "time.checkpointMinutes": 30, "resources.minCpus": 8, "resources.maxCpus": 4, "resources.minMemoryMb": 4096, "resources.maxMemoryMb": 2048 });
    assert.ok(!impossible.applied && impossible.problems.length === 3 && impossible.problems.some((p) => /first checkpoint/.test(p)) && impossible.problems.some((p) => /CPUs/.test(p)) && impossible.problems.some((p) => /memory/.test(p)), impossible.problems.join("; "));
    const own = await put(c, c.owner, "team", c.team, { "routing.fallbackProfile.fast": "fast" });
    assert.ok(!own.applied && own.problems.some((p) => /circle/.test(p)));
  });

  suite("values and names are checked: unknown settings, wrong types, out-of-range numbers and bad scopes are refused at once", async (c) => {
    const stage = (set: Record<string, unknown>, layer: LayerKind = "installation", scopeId?: string) => c.config.stage(c.owner, { commandId: cid("st"), layer, ...(scopeId === undefined ? {} : { scopeId }), set });
    await refuses("invalid_command", () => stage({ "no.such.setting": 1 }), (e) => assert.match(e.message, /not a setting/));
    await refuses("invalid_command", () => stage({ "NotAKey": 1 }));
    for (const bad of [{ "budget.paidAllowed": "yes" }, { "time.maxMinutes": 0 }, { "time.maxMinutes": 1.5 }, { "time.maxMinutes": 99999 }, { "permissions.allowedTools": "run-script" }, { "permissions.allowedTools": ["Bad Name"] }, { "workClass.pcFloor": 101 }, { "routing.fallbackProfile.x": 5 }]) {
      await refuses("invalid_command", () => stage(bad), (e) => assert.match(e.message, /set\./));
    }
    await refuses("invalid_command", () => stage({}), (e) => assert.match(e.message, /nothing to stage/));
    await refuses("invalid_command", () => stage({ "workClass.pcFloor": 1 }, "team", "nope"));
    await refuses("invalid_command", () => stage({ "workClass.pcFloor": 1 }, "installation", c.team));
    await refuses("invalid_command", () => stage({ "workClass.pcFloor": 1 }, "wide" as LayerKind));
    await refuses("not_found", () => stage({ "workClass.pcFloor": 1 }, "team", "team-aaaaaaaaaaaaaaaaaaaa"));
    await refuses("invalid_command", () => c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", remove: ["workClass.pcFloor"] }), (e) => assert.match(e.message, /not set in this layer/));
    await refuses("invalid_command", () => c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", lock: ["workClass.pcFloor"] }), (e) => assert.match(e.message, /not set in this layer/));
  });

  suite("who may write: the owner anywhere; a writer on team, agent and task layers but never the installation or a lock; others not at all", async (c) => {
    await refuses("forbidden", () => c.config.stage(c.nobody, { commandId: cid("st"), layer: "task", scopeId: c.task, set: { "workClass.pcFloor": 1 } }));
    await refuses("forbidden", () => c.config.stage(c.broad, { commandId: cid("st"), layer: "task", scopeId: c.task, set: { "workClass.pcFloor": 1 } }), (e) => assert.match(e.message, /names config.write/));
    await refuses("forbidden", () => c.config.stage(c.writer, { commandId: cid("st"), layer: "installation", set: { "workClass.pcFloor": 1 } }), (e) => assert.match(e.message, /only the owner/));
    await put(c, c.writer, "task", c.task, { "workClass.pcFloor": 5 });
    await put(c, c.writer, "agent", c.agentA, { "workClass.pcFloor": 6 });
    await refuses("forbidden", () => c.config.stage(c.writer, { commandId: cid("st"), layer: "agent", scopeId: c.agentA, expectedRevision: 2, lock: ["workClass.pcFloor"] }), (e) => assert.match(e.message, /lock/));
    // A writer is held to the same narrowing as the owner.
    await put(c, c.owner, "installation", undefined, { "provider.p.enabled": false });
    await refuses("invalid_command", () => stageNow(c, c.writer, "agent", c.agentB, { set: { "provider.p.enabled": true } }));
    // Reading: the owner and readers; an agent for its own scope only.
    assert.ok(await c.config.effective(c.writer, { agentId: c.agentA }));
    assert.ok(await c.config.effective(c.agentPrincipal, { agentId: c.agentA }));
    assert.equal(await c.config.effective(c.otherAgentPrincipal, { agentId: c.agentA }), undefined);
    assert.equal(await c.config.effective(c.nobody, {}), undefined);
    assert.equal(await c.config.layer(c.nobody, "agent", c.agentA), undefined);
    assert.ok(await c.config.layer(c.agentPrincipal, "agent", c.agentA));
    assert.equal(await c.config.layer(c.agentPrincipal, "agent", c.agentB), undefined);
    assert.equal(await c.config.effective(c.owner, { agentId: "agt-aaaaaaaaaaaaaaaaaaaa" }), undefined);
  });

  const table = {
    providers: { local: { enabled: true, paid: false, location: "local" }, cloud: { enabled: true, paid: true, location: "cloud" } },
    routes: { "local/small": { contextTokens: 8000, capabilities: ["tools"] }, "cloud/big": { contextTokens: 200000, capabilities: ["tools", "vision"] }, "cloud/mid": { contextTokens: 64000, capabilities: ["tools"] } },
    profiles: { fast: ["local/small", "cloud/mid"], careful: ["cloud/big", "cloud/mid"] },
    roles: { worker: "fast" },
  };

  suite("the configuration's routing section loads into the routing table after it is checked against the configuration, and a missing profile or circle is refused", async (c) => {
    await put(c, c.owner, "installation", undefined, { "routing.fallbackProfile.fast": "careful" });
    // The fallback names a profile the document does not have.
    await refuses("invalid_command", () => c.config.bindRouting(c.owner, { commandId: cid("br"), expectedRevision: 0, routing: { ...table, profiles: { fast: table.profiles.fast } } }), (e) => assert.match(e.message, /not in the routing table/));
    const bound = await c.config.bindRouting(c.owner, { commandId: cid("br"), expectedRevision: 0, routing: table });
    assert.equal(bound.revision, 1);
    assert.deepEqual((await c.routing.get())!.profiles.fast, ["local/small", "cloud/mid"]);
    await refuses("stale_revision", () => c.config.bindRouting(c.owner, { commandId: cid("br"), expectedRevision: 0, routing: table }));
    await refuses("forbidden", () => c.config.bindRouting(c.nobody, { commandId: cid("br"), expectedRevision: 1, routing: table }));
    // A broad grant is not enough: routing.write has to be named.
    await refuses("forbidden", () => c.config.bindRouting(c.broad, { commandId: cid("br"), expectedRevision: 1, routing: table }));
    await refuses("invalid_command", () => c.config.bindRouting(c.owner, { commandId: cid("br"), expectedRevision: 1, routing: "text" }));
    // With a table in place, applying a fallback to a profile that does not exist is refused too.
    const bad = await put(c, c.owner, "team", c.team, { "routing.fallbackProfile.careful": "nonesuch" });
    assert.ok(!bad.applied && bad.problems.some((p) => /not in the routing table/.test(p)));
  });

  suite("reordering a profile from the screen and from the coordinator agent gives the same table and the same routing revision; a reorder must keep the same routes", async (c) => {
    await c.config.bindRouting(c.owner, { commandId: cid("br"), expectedRevision: 0, routing: table });
    const order = ["cloud/mid", "local/small"];
    await refuses("forbidden", () => c.config.reorderProfile(c.nobody, { commandId: cid("ro"), expectedRevision: 1, profile: "fast", order }));
    for (const bad of [["cloud/mid"], ["cloud/mid", "local/small", "cloud/big"], ["cloud/mid", "cloud/mid"], ["cloud/big", "local/small"], "x"]) {
      await refuses("invalid_command", () => c.config.reorderProfile(c.owner, { commandId: cid("ro"), expectedRevision: 1, profile: "fast", order: bad as never }));
    }
    await refuses("invalid_command", () => c.config.reorderProfile(c.owner, { commandId: cid("ro"), expectedRevision: 1, profile: "none", order }));
    await refuses("stale_revision", () => c.config.reorderProfile(c.owner, { commandId: cid("ro"), expectedRevision: 7, profile: "fast", order }));
    const byOwner = await c.config.reorderProfile(c.owner, { commandId: cid("ro"), expectedRevision: 1, profile: "fast", order });
    const ownerTable = (await c.routing.get())!;
    // The same starting point, the same request, from the delegate: in a second world.
    let delegate: { revision: number; fast: readonly string[]; careful: readonly string[] } | undefined;
    await open(backend, async (d) => {
      await d.config.bindRouting(d.owner, { commandId: cid("br"), expectedRevision: 0, routing: table });
      const r = await d.config.reorderProfile(d.routingWriter, { commandId: cid("ro"), expectedRevision: 1, profile: "fast", order });
      const t = (await d.routing.get())!;
      delegate = { revision: r.revision, fast: t.profiles.fast!, careful: t.profiles.careful! };
    });
    assert.deepEqual([byOwner.revision, ownerTable.profiles.fast, ownerTable.profiles.careful], [delegate!.revision, delegate!.fast, delegate!.careful]);
    assert.deepEqual(ownerTable.profiles.fast, order);
  });

  suite("applying configuration changes nothing but configuration: assignments and the rest of the task are untouched", async (c) => {
    await c.projects.transitionTask({ commandId: cid("tr"), actor: c.owner.id, taskId: c.task, expectedRevision: 1, to: "ready" });
    await c.assignments.assignTask({ commandId: cid("as"), actor: c.owner.id, taskId: c.task, owner: { kind: "agent", id: "agent-a" } });
    const before = JSON.stringify(await c.assignments.getAssignment(c.task));
    const taskBefore = (await c.projects.getTask(c.task))!.revision;
    await put(c, c.owner, "installation", undefined, { "budget.paidAllowed": false });
    await put(c, c.owner, "task", c.task, { "time.maxMinutes": 30 });
    await c.config.bindRouting(c.owner, { commandId: cid("br"), expectedRevision: 0, routing: table });
    assert.equal(JSON.stringify(await c.assignments.getAssignment(c.task)), before);
    assert.equal((await c.projects.getTask(c.task))!.revision, taskBefore);
  });

  suite("two applies at the same moment: one wins, the other is told the layer moved; a change above while applying below is never lost", async (c) => {
    const staged = await c.config.stage(c.owner, { commandId: cid("st"), layer: "agent", scopeId: c.agentA, set: { "workClass.pcFloor": 12 } });
    const results = await Promise.allSettled([
      c.config.apply(c.owner, { commandId: cid("ap"), layer: "agent", scopeId: c.agentA, expectedRevision: staged.revision }),
      c.config.apply(c.owner, { commandId: cid("ap"), layer: "agent", scopeId: c.agentA, expectedRevision: staged.revision }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await c.config.history(c.owner, "agent", c.agentA))!.length, 1);
    // An installation lock and an agent change racing: either the lock lands first (and the change is refused) or the change lands and the lock then ignores it; never an agent value that counts under a lock.
    for (let round = 0; round < 3; round++) {
      const key = ["resources.maxCpus", "resources.maxMemoryMb", "time.maxMinutes"][round]!;
      const value = round === 0 ? 5 : 8;
      const layer = (await c.config.layer(c.owner, "installation"));
      const lockStage = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", ...(layer === undefined ? {} : { expectedRevision: layer.revision }), set: { [key]: value + 100 }, lock: [key] });
      const agentLayer = await c.config.layer(c.owner, "agent", c.agentA);
      const agentStage = await c.config.stage(c.owner, { commandId: cid("st"), layer: "agent", scopeId: c.agentA, expectedRevision: agentLayer!.revision, set: { [key]: value } }).catch(() => undefined);
      await Promise.allSettled([
        c.config.apply(c.owner, { commandId: cid("ap"), layer: "installation", expectedRevision: lockStage.revision }),
        ...(agentStage === undefined ? [] : [c.config.apply(c.owner, { commandId: cid("ap"), layer: "agent", scopeId: c.agentA, expectedRevision: agentStage.revision })]),
      ]);
      const got = (await value_(c, key, c.agentA))!;
      if (got.lockedBy !== undefined) assert.equal(got.source.layer === "agent", false, `${key} came from the agent layer under a lock`);
    }
  });

  // Review of card F04m (third slice): the controller's own setting changes are one write, so a stop cannot leave a half-made change staged, and nothing staged goes into force with them.
  suite("change: sets and puts in force in one write; a draft in the layer is neither applied nor touched; revision checked; a refused combination writes nothing; a repeat is answered from its record", async (c) => {
    // A new layer: 0 means it must not exist yet.
    const first = await c.config.change(c.owner, { commandId: "ch-1", layer: "installation", expectedRevision: 0, set: { "grants.maxDays": 30 } });
    assert.deepEqual([first.revision, first.replayed, first.takesEffect], [1, false, { "grants.maxDays": "next-request" }]);
    assert.equal((await value(c, "grants.maxDays"))!.value, 30);
    await refuses("stale_revision", () => c.config.change(c.owner, { commandId: "ch-0", layer: "installation", expectedRevision: 0, set: { "grants.maxDays": 31 } }));
    // Something staged and not applied (what a stop between the old stage and apply left behind).
    const staged = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", expectedRevision: first.revision, set: { "grants.defaultDays": 3, "conversation.mcp.enabled": false } });
    const draft = (await c.config.layer(c.owner, "installation"))!.draft;
    const second = await c.config.change(c.owner, { commandId: "ch-2", layer: "installation", expectedRevision: staged.revision, set: { "grants.maxDays": 40 } });
    assert.equal(second.revision, staged.revision + 1);
    const layer = (await c.config.layer(c.owner, "installation"))!;
    assert.deepEqual(layer.draft, draft, "the draft is kept exactly as it was");
    assert.deepEqual([(await value(c, "grants.maxDays"))!.value, (await value(c, "grants.defaultDays"))?.source.layer ?? "default", (await value(c, "conversation.mcp.enabled"))!.value], [40, "default", true], "only the change's own key went into force");
    assert.deepEqual(layer.history.at(-1)!.set, ["grants.maxDays"]);
    // Stale: refused, nothing written.
    await refuses("stale_revision", () => c.config.change(c.owner, { commandId: "ch-3", layer: "installation", expectedRevision: staged.revision, set: { "grants.maxDays": 50 } }));
    assert.equal((await c.config.layer(c.owner, "installation"))!.revision, second.revision);
    // A combination that does not fit is refused and writes nothing (no failure record, no draft).
    await refuses("invalid_command", () => c.config.change(c.owner, { commandId: "ch-4", layer: "installation", set: { "workClass.pcFloor": 80, "workClass.pcCeiling": 60 } }), (e) => assert.match(e.message, /^the configuration check refused it: .*pcFloor \(80\) is above workClass.pcCeiling \(60\)/));
    const after = (await c.config.layer(c.owner, "installation"))!;
    assert.deepEqual([after.revision, after.lastFailure, after.draft], [second.revision, undefined, draft]);
    // A repeat of the same command is answered from what it recorded, even after the layer moved on without a revision given.
    const free = await c.config.change(c.owner, { commandId: "ch-5", layer: "installation", set: { "workClass.pcFloor": 5 } });
    await c.config.change(c.owner, { commandId: "ch-6", layer: "installation", set: { "workClass.pcCeiling": 90 } });
    const again = await c.config.change(c.owner, { commandId: "ch-5", layer: "installation", set: { "workClass.pcFloor": 5 } });
    assert.deepEqual([again.revision, again.replayed, again.takesEffect], [free.revision, true, { "workClass.pcFloor": "next-request" }]);
    await refuses("command_conflict", () => c.config.change(c.owner, { commandId: "ch-5", layer: "installation", set: { "workClass.pcFloor": 6 } }));
    // Remove: only a key that is in force here; a key both set and removed is refused; a value check still applies.
    const now = (await c.config.layer(c.owner, "installation"))!.revision;
    await refuses("invalid_command", () => c.config.change(c.owner, { commandId: "ch-7", layer: "installation", expectedRevision: now, remove: ["grants.defaultDays"] }), (e) => assert.match(e.message, /not set in this layer/));
    await refuses("invalid_command", () => c.config.change(c.owner, { commandId: "ch-8", layer: "installation", expectedRevision: now, set: { "grants.maxDays": 1 }, remove: ["grants.maxDays"] }));
    await refuses("invalid_command", () => c.config.change(c.owner, { commandId: "ch-9", layer: "installation", expectedRevision: now, set: { "grants.maxDays": 0 } }));
    await refuses("invalid_command", () => c.config.change(c.owner, { commandId: "ch-10", layer: "installation", expectedRevision: -1, set: { "grants.maxDays": 2 } }));
    const removed = await c.config.change(c.owner, { commandId: "ch-11", layer: "installation", expectedRevision: now, remove: ["grants.maxDays"] });
    assert.equal((await value(c, "grants.maxDays"))?.source.layer ?? "default", "default");
    assert.deepEqual((await c.config.layer(c.owner, "installation"))!.history.at(-1)!.removed, ["grants.maxDays"]);
    void removed;
    // Rights as for stage: the installation layer is the owner's; a writer may change a task layer, never wider than above.
    await refuses("forbidden", () => c.config.change(c.writer, { commandId: "ch-12", layer: "installation", set: { "grants.maxDays": 3 } }));
    await c.config.change(c.owner, { commandId: "ch-13", layer: "installation", set: { "time.maxMinutes": 60 } });
    await refuses("invalid_command", () => c.config.change(c.writer, { commandId: "ch-14", layer: "task", scopeId: c.task, set: { "time.maxMinutes": 120 } }), (e) => assert.match(e.message, /wider than the layers above allow/));
    await c.config.change(c.writer, { commandId: "ch-15", layer: "task", scopeId: c.task, expectedRevision: 0, set: { "time.maxMinutes": 30 } });
    assert.equal((await value(c, "time.maxMinutes", { taskId: c.task }))!.value, 30);
    // The draft is still there, still out of force, after all of it.
    assert.deepEqual((await c.config.layer(c.owner, "installation"))!.draft, draft);
  });

  // Clean-context review of the one-write change: what the change keeps and refuses beyond the first suite.
  suite("change: a lock in the layer stays (a later change does not unlock it); a value locked above is refused; a layer of something that does not exist is not_found and writes nothing", async (c) => {
    await put(c, c.owner, "installation", undefined, { "time.maxMinutes": 100 }, { lock: ["time.maxMinutes"] });
    const before = (await c.config.layer(c.owner, "installation"))!;
    await c.config.change(c.owner, { commandId: cid("ch"), layer: "installation", expectedRevision: before.revision, set: { "time.maxMinutes": 90 } });
    const layer = (await c.config.layer(c.owner, "installation"))!;
    assert.deepEqual(layer.applied["time.maxMinutes"], { value: 90, locked: true }, "the owner's lock is kept by a change of the value");
    assert.deepEqual(layer.history.at(-1)!.unlocked, []);
    assert.equal((await value(c, "time.maxMinutes", { agentId: c.agentA }))!.lockedBy?.layer, "installation");
    await refuses("invalid_command", () => c.config.change(c.writer, { commandId: cid("ch"), layer: "agent", scopeId: c.agentA, set: { "time.maxMinutes": 30 } }), (e) => assert.match(e.message, /locked by the installation layer/));
    await refuses("invalid_command", () => c.config.change(c.owner, { commandId: cid("ch"), layer: "task", scopeId: c.task, set: { "time.maxMinutes": 30 } }), (e) => assert.match(e.message, /locked by the installation layer/));
    assert.equal(await c.config.layer(c.owner, "agent", c.agentA), undefined);
    await refuses("not_found", () => c.config.change(c.owner, { commandId: cid("ch"), layer: "team", scopeId: "team-aaaaaaaaaaaaaaaaaaaa", set: { "workClass.pcFloor": 1 } }));
    await refuses("not_found", () => c.config.change(c.owner, { commandId: cid("ch"), layer: "agent", scopeId: "agt-aaaaaaaaaaaaaaaaaaaa", expectedRevision: 0, set: { "workClass.pcFloor": 1 } }));
    assert.equal(await c.config.layer(c.owner, "team", "team-aaaaaaaaaaaaaaaaaaaa"), undefined);
    assert.equal(await c.config.layer(c.owner, "agent", "agt-aaaaaaaaaaaaaaaaaaaa"), undefined);
  });

  suite("change: a lock above that lands while a change below is being written makes the change below stale; it never goes into force under the lock", async (c) => {
    // The storage the agent-layer change commits through runs the owner's installation lock first, between the change's read of the layers above and its own write.
    let race: (() => Promise<void>) | undefined;
    const racing = new Proxy(c.storage, { get(target, prop, receiver) {
      if (prop === "applyOperation") return async (input: OperationInput) => { const go = race; race = undefined; if (go !== undefined && input.audit[0]?.type === "config.change") await go(); return target.applyOperation(input); };
      const v = Reflect.get(target, prop, receiver) as unknown; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } });
    const below = ConfigurationService.withEpoch(racing, c.epoch, { ...options, routing: c.routing });
    await put(c, c.owner, "installation", undefined, { "time.maxMinutes": 100 });
    race = async () => { await put(c, c.owner, "installation", undefined, { "time.maxMinutes": 100 }, { lock: ["time.maxMinutes"] }); };
    await refuses("stale_revision", () => below.change(c.owner, { commandId: cid("ch"), layer: "agent", scopeId: c.agentA, expectedRevision: 0, set: { "time.maxMinutes": 40 } }));
    assert.equal(race, undefined, "the lock ran in between");
    assert.equal(await c.config.layer(c.owner, "agent", c.agentA), undefined);
    const got = (await value(c, "time.maxMinutes", { agentId: c.agentA }))!;
    assert.deepEqual([got.value, got.source.layer, got.lockedBy?.layer], [100, "installation", "installation"]);
    // Two changes creating the same layer at once: one goes in, the other is told the layer moved (not that its command ID was used by something else).
    const both = await Promise.allSettled([1, 2].map((v) => c.config.change(c.owner, { commandId: cid("ch"), layer: "team", scopeId: c.team, expectedRevision: 0, set: { "workClass.pcFloor": v } })));
    assert.equal(both.filter((r) => r.status === "fulfilled").length, 1);
    const lost = both.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(lost.reason instanceof DomainError && lost.reason.code === "stale_revision", String(lost.reason));
    assert.equal((await c.config.history(c.owner, "team", c.team))!.length, 1);
  });
}

async function value_(c: Ctx, key: string, agentId: string) { return (await c.config.effective(c.owner, { agentId }))!.values[key]; }
