import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { ResponsibilityChecks } from "./checks.js";
import { CoverageGapService, gapAppliesTo, routeUseOf, type RouteUse } from "./coverage-gaps.js";
import { ResponsibilityService } from "./index.js";
import { noteSuspendedResponsibilities } from "./suspend-notes.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const T0 = "2026-11-15T10:00:00.000Z";
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const ctl = { id: "service:stop-notes", kind: "owner", name: "stop-notes", grants: [] } as unknown as Principal;

interface World { owner: Principal; project: string; duties: ResponsibilityService; checks: ResponsibilityChecks; gaps(routesOf?: (ownerId: string) => Promise<RouteUse | undefined>): CoverageGapService; ids: { web: string; db: string; other: string; solo: string }; setNow(iso: string): void }

for (const backend of backends) {
  const suite = (name: string, body: (c: World) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      let now = T0;
      const options = { clock: () => now, pause: async () => undefined };
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const duties = ResponsibilityService.withEpoch(world.storage, projects.epoch, options);
        const checks = ResponsibilityChecks.withEpoch(world.storage, projects.epoch, duties, options);
        for (const name of ["ann", "bob"]) await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name, grants: [] } as never);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Ops" })).id;
        const mk = async (title: string, ownerId?: string): Promise<string> => (await duties.create(owner, { commandId: cid("r"), projectId: project, title, objective: "Up", everyMinutes: 60, ...(ownerId === undefined ? {} : { ownerId }) } as never)).id;
        const ids = { web: await mk("Web", "agent:ann"), db: await mk("Db", "agent:ann"), other: await mk("Cache", "agent:bob"), solo: await mk("Nobody") };
        await body({ owner, project, duties, checks, gaps: (routesOf) => CoverageGapService.withEpoch(world.storage, projects.epoch, { ...options, ...(routesOf === undefined ? {} : { routesOf }) }), ids, setNow: (iso) => { now = iso; } });
      } finally { await world.close(); }
    });

  const notes = async (duties: ResponsibilityService, owner: Principal, id: string): Promise<string[]> => (await duties.history(owner, id, { limit: 50 }))!.items.filter((h) => h.kind === "note").map((h) => h.summary);

  suite("stopping a team writes one note per responsibility of its agents, an agent reached twice is noted once, and a repeat of the request writes nothing (T3)", async ({ owner, duties, ids }) => {
    const ports = { teamAgents: async (team: string) => (team === "team-x" ? ["ann", "ann", "bob"] : []) };
    const event = { intentId: "team-1", scope: { kind: "team", id: "team-x" } as const, mode: "suspend" as const, outcome: { state: "suspended" as const } };
    const first = await noteSuspendedResponsibilities(duties, ctl, event, ports);
    assert.deepEqual(first.noted.map((x) => x.id).sort(), [ids.db, ids.other, ids.web].sort(), "the three responsibilities with an answering agent, none for the one with nobody");
    for (const id of [ids.web, ids.db, ids.other]) { const list = await notes(duties, owner, id); assert.equal(list.length, 1); assert.match(list[0]!, /was suspended with its team\..*does not stop the service it maintains.*Suspend and Release/); }
    assert.deepEqual(await notes(duties, owner, ids.solo), []);
    await noteSuspendedResponsibilities(duties, ctl, event, ports);
    assert.equal((await notes(duties, owner, ids.web)).length, 1, "a repeat of the same request writes nothing more");
    assert.deepEqual((await noteSuspendedResponsibilities(duties, ctl, { ...event, intentId: "team-2", scope: { kind: "team", id: "team-empty" } }, ports)).noted, [], "a team with no agents notes nothing");
    assert.deepEqual((await noteSuspendedResponsibilities(duties, ctl, { ...event, intentId: "team-3" })).noted, [], "without the team port the scope is not noted");
    assert.deepEqual((await noteSuspendedResponsibilities(duties, ctl, { ...event, intentId: "team-4", outcome: { state: "recovery-required" } }, ports)).noted, [], "an unfinished stop says nothing");
    const stopped = await noteSuspendedResponsibilities(duties, ctl, { ...event, intentId: "team-5", mode: "stop", outcome: { state: "stopped" } }, ports);
    assert.equal(stopped.noted.length, 3);
    assert.ok((await notes(duties, owner, ids.web)).some((s) => /was stopped with its team/.test(s)), "worded by what happened");
  });

  suite("stopping a task notes the responsibilities whose checks it carried, once, and not a retired one or one that task never took up (T3)", async ({ owner, project, duties, checks, ids, setNow }) => {
    setNow(at(125));
    const made = await checks.generate(owner, project);
    assert.ok(made.length >= 2, "checks came due");
    const all = (await checks.pending(owner, project))!;
    const ofWeb = all.find((c) => c.responsibilityId === ids.web)!; const ofDb = all.find((c) => c.responsibilityId === ids.db)!; const ofOther = all.find((c) => c.responsibilityId === ids.other)!;
    await checks.noteRun(owner, ofWeb.id, { how: "task", at: at(126), taskId: "task-a", attempt: 1, summary: "task opened" });
    await checks.noteRun(owner, ofDb.id, { how: "coalesced", at: at(126), taskId: "task-a", summary: "rides on task-a" });
    await checks.noteRun(owner, ofOther.id, { how: "task", at: at(126), taskId: "task-b", attempt: 1, summary: "task opened" });
    assert.deepEqual(await checks.responsibilitiesOfTask(ctl, "task-a"), [ids.db, ids.web].sort());
    await assert.rejects(checks.responsibilitiesOfTask({ id: "agent:x", kind: "agent", name: "x", grants: [] } as unknown as Principal, "task-a"), /may not/);
    const ports = { taskResponsibilities: (task: string) => checks.responsibilitiesOfTask(ctl, task) };
    const event = { intentId: "task-1", scope: { kind: "task", id: "task-a" } as const, mode: "stop" as const, outcome: { state: "stopped" as const } };
    const first = await noteSuspendedResponsibilities(duties, ctl, event, ports);
    assert.deepEqual(first.noted.map((x) => x.id).sort(), [ids.db, ids.web].sort());
    const list = await notes(duties, owner, ids.web);
    assert.equal(list.length, 1);
    assert.match(list[0]!, /A task that took up one of this responsibility's checks was stopped\..*stays owed.*Suspend and Release/);
    assert.doesNotMatch(list[0]!, /nothing watches it/, "the agent itself keeps working");
    assert.deepEqual(await notes(duties, owner, ids.other), [], "another task's responsibility is not noted");
    await noteSuspendedResponsibilities(duties, ctl, event, ports);
    assert.equal((await notes(duties, owner, ids.web)).length, 1, "a repeat writes nothing");
    await duties.update(owner, { commandId: cid("ret"), responsibilityId: ids.db, expectedRevision: (await duties.get(owner, ids.db))!.revision, state: "retired" } as never);
    assert.deepEqual((await noteSuspendedResponsibilities(duties, ctl, { ...event, intentId: "task-2" }, ports)).noted.map((x) => x.id), [ids.web], "a retired responsibility is skipped");
    assert.deepEqual((await noteSuspendedResponsibilities(duties, ctl, { ...event, intentId: "task-3", scope: { kind: "task", id: "task-none" } }, ports)).noted, []);
    assert.deepEqual((await noteSuspendedResponsibilities(duties, ctl, { ...event, intentId: "task-4" })).noted, [], "without the task port the scope is not noted");
  });

  suite("a provider outage is listed only for a responsibility whose agent uses that route, account or endpoint; unknown routes keep it listed (T3)", async ({ owner, project, duties, ids, gaps }) => {
    const known: Record<string, RouteUse | undefined> = {
      "agent:ann": { models: ["local/qwen"], accounts: ["local-acct"], endpoints: ["local-http"] },
      "agent:bob": undefined,
    };
    const g = gaps(async (ownerId) => known[ownerId]);
    const start = at(-30);
    for (const key of ["provider:model:cloud/qwen", "provider:account:cloud-acct", "provider:endpoint:cloud-api", "provider:endpoint:local-http", "provider:model:local/qwen", "provider:account:local-acct"]) assert.ok(await g.open(owner, { key, reason: "provider-outage", start, detail: key } as never));
    await g.open(owner, { key: "source:files", reason: "event-source-outage", start, detail: "files" } as never);
    const covering = async (id: string, ownerId: string | undefined) => (await g.covering(owner, project, at(-20), at(5), { id, ...(ownerId === undefined ? {} : { ownerId }), eventSources: [] })).map((x) => x.reason);
    assert.deepEqual(await covering(ids.web, "agent:ann"), ["provider-outage", "provider-outage", "provider-outage"], "only the local endpoint, model and account");
    assert.deepEqual(await covering(ids.other, "agent:bob"), Array(6).fill("provider-outage"), "unknown routes: every outage is listed, the source outage (not named) is not");
    assert.deepEqual(await covering(ids.solo, undefined), [], "nobody answers: no model is asked");
    const plain = gaps();
    assert.equal((await plain.covering(owner, project, at(-20), at(5), { id: ids.web, ownerId: "agent:ann", eventSources: [] })).length, 6, "no way to read routes: all stay listed");
    const failing = gaps(async () => { throw new Error("routing busy"); });
    assert.equal((await failing.covering(owner, project, at(-20), at(5), { id: ids.web, ownerId: "agent:ann", eventSources: [] })).length, 6, "a failed read leaves them unknown, never hidden");
    void duties;
  });

  suite("the routes of an agent come from its default profile only when nothing could override it (T3)", async () => {
    const target = (route: string) => ({ canonical: route.replace("alias/", "local/"), account: route.startsWith("cloud") ? "cloud-acct" : "local-acct", endpoint: route.startsWith("cloud") ? "cloud-api" : "local-http" });
    const profiles = { main: ["local/qwen", "cloud/qwen"], solo: ["alias/qwen"] };
    assert.deepEqual(routeUseOf({ defaultProfile: "main" }, profiles, target), { models: ["local/qwen", "cloud/qwen"], accounts: ["local-acct", "cloud-acct"], endpoints: ["local-http", "cloud-api"] });
    assert.deepEqual(routeUseOf({ defaultProfile: "solo", permittedOverrides: [] }, profiles, target)?.models, ["local/qwen"], "an alias counts as the route it resolves to");
    assert.equal(routeUseOf({}, profiles, target), undefined, "no default profile: unknown");
    assert.equal(routeUseOf({ defaultProfile: "gone" }, profiles, target), undefined, "a profile the table lacks: unknown");
    assert.equal(routeUseOf({ defaultProfile: "main", permittedOverrides: ["profile"] }, profiles, target), undefined, "an override could use another profile: unknown");
    const use = routeUseOf({ defaultProfile: "main" }, profiles, target)!;
    const gap = (key: string) => ({ reason: "provider-outage" as const, key });
    const duty = { id: "r", ownerId: "agent:ann", eventSources: [] as string[], routes: use };
    assert.deepEqual([gapAppliesTo(gap("provider:model:local/qwen"), duty), gapAppliesTo(gap("provider:model:other/x"), duty), gapAppliesTo(gap("provider:account:cloud-acct"), duty), gapAppliesTo(gap("provider:endpoint:cloud-api"), duty), gapAppliesTo(gap("provider:endpoint:nowhere"), duty)], [true, false, true, true, false]);
    assert.equal(gapAppliesTo(gap("provider:model:local/qwen"), { ...duty, routes: { ...use, models: [] } }), false, "the kind of name matters: a model is not matched against accounts");
    assert.equal(gapAppliesTo(gap("provider:account:local/qwen"), { ...duty, routes: { ...use, models: ["local/qwen"], accounts: [] } }), false);
    assert.equal(gapAppliesTo(gap("provider:weird"), duty), true, "a key that cannot be read is not hidden");
    assert.equal(gapAppliesTo(gap(`provider:model:${"m".repeat(160)}`), duty), true, "a key cut at its limit is not hidden");
    assert.equal(gapAppliesTo(gap("provider:model:local/qwen"), { id: "r", eventSources: [], routes: use }), false, "still nobody answering: not about it");
    assert.equal(gapAppliesTo(gap("provider:model:zzz"), { id: "r", ownerId: "agent:ann", eventSources: [] }), true, "routes unknown: listed");
  });
}
