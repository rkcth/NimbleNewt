import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ContractService } from "../planning/contracts.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { CRITICAL_LIMITS, CriticalPathService } from "./index.js";

// Card U11d ("U11f"): the owner marks the critical path; nothing an agent supplies decides it.

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refused = async (promise: Promise<unknown>, code: string, part?: string): Promise<void> => {
  await assert.rejects(promise, (e: unknown) => e instanceof DomainError && e.code === code && (part === undefined || e.message.includes(part)), `expected ${code}${part === undefined ? "" : ` (${part})`}`);
};

for (const backend of backends) {
  const suite = (name: string, body: (c: {
    svc: CriticalPathService; broken: CriticalPathService; storage: ControllerStorage; epoch: number; owner: Principal; ann: Principal; host: Principal; service: Principal; projects: ProjectService; contracts: ContractService;
    pa: string; pb: string; task(project?: string, title?: string): Promise<string>; dep(task: string, prerequisite: string): Promise<void>; finish(task: string): Promise<void>;
    mark(kind: string, id: string, marked?: boolean): Promise<{ revision: number; changed: boolean; marks: number }>; holds(): Promise<(t: string) => Promise<boolean>>;
  }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const options = { pause: async () => undefined };
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = (await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token))!;
        const enroll = async (kind: "agent" | "host" | "service", nm: string): Promise<Principal> => { await principals.enroll(owner, { commandId: cid("e"), kind, name: nm, grants: kind === "service" ? [{ action: "recovery.stall-scan", project: "*" }] : kind === "host" ? [] : [{ action: "*", project: "*" }] } as never); return (await principals.authenticate((await principals.issueCredential(owner, `${kind}:${nm}`)).token))!; };
        const ann = await enroll("agent", "ann"); const host = await enroll("host", "h1"); const service = await enroll("service", "svc");
        const contracts = ContractService.withEpoch(world.storage, projects.epoch, options);
        const svc = CriticalPathService.withEpoch(world.storage, projects.epoch, { ...options, edges: (p) => contracts.activeEdges(p) });
        const pa = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const pb = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const task = async (project = pa, title = "A task"): Promise<string> => (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: project, title })).id;
        await body({
          svc, broken: CriticalPathService.withEpoch(world.storage, projects.epoch, { ...options, edges: async () => { throw new Error("edges are unreadable"); } }), storage: world.storage, epoch: projects.epoch, owner, ann, host, service, projects, contracts, pa, pb, task,
          dep: async (t, p) => { await contracts.addDependency(owner, { commandId: cid("d"), taskId: t, prerequisiteId: p }); },
          finish: async (t) => {
            let rec = (await projects.getTask(t))!;
            for (const to of ["ready", "in_progress", "done"] as const) { rec = (await projects.transitionTask({ commandId: cid("m"), actor: "owner:rob", taskId: t, expectedRevision: rec.revision, to })) as never; }
          },
          mark: (kind, id, marked) => svc.mark(owner, { commandId: cid("mk"), kind, ...(kind === "project" ? { projectId: id } : { taskId: id }), ...(marked === undefined ? {} : { marked }) }),
          holds: async () => (await svc.holdsUp()) ?? (async () => false),
        });
      } finally { await world.close(); }
    });

  suite("only the owner marks or reads the critical path: an agent, a host, a service and a task credential are refused and nothing is written (who may call)", async (c) => {
    const t = await c.task();
    for (const who of [c.ann, c.host, c.service]) {
      await refused(c.svc.mark(who, { commandId: cid("x"), kind: "task", taskId: t }), "forbidden");
      await refused(c.svc.list(who), "forbidden");
    }
    assert.deepEqual((await c.svc.list(c.owner)).marks, []);
    assert.equal(await c.svc.holdsUp(), undefined, "nothing marked: nothing to look up");
    assert.equal(await c.svc.anyMarked(), false);
  });

  suite("a task, a goal and a project are marked by ID, the mark is listed, changing the scope replaces it and unmarking removes it", async (c) => {
    const t = await c.task(); const g = await c.task();
    const first = await c.mark("task", t);
    assert.equal(first.changed, true); assert.equal(first.marks, 1);
    assert.equal((await c.mark("task", t)).changed, false, "the same mark again changes nothing");
    assert.equal((await c.mark("goal", t)).changed, true, "the other scope replaces it");
    await c.mark("goal", g); await c.mark("project", c.pb);
    const listed = await c.svc.list(c.owner);
    assert.deepEqual(listed.marks.map((m) => `${m.kind}:${m.id}`).sort(), [`goal:${g}`, `goal:${t}`, `project:${c.pb}`].sort());
    assert.ok(listed.revision > 0);
    const gone = await c.mark("goal", t, false);
    assert.equal(gone.changed, true);
    assert.equal((await c.mark("goal", t, false)).changed, false, "unmarking what is not marked changes nothing");
    assert.equal((await c.svc.list(c.owner)).marks.length, 2);
    await c.mark("project", c.pb, false); await c.mark("goal", g, false);
    assert.equal(await c.svc.anyMarked(), false);
  });

  suite("marks are checked: unknown fields, scopes and IDs, a missing or wrong target, a foreign project beside a task, and the bound of marks (bounds)", async (c) => {
    const t = await c.task();
    const owner = c.owner;
    await refused(c.svc.mark(owner, { commandId: cid("x"), kind: "everything", taskId: t }), "invalid_command", "kind");
    await refused(c.svc.mark(owner, { commandId: cid("x"), taskId: t }), "invalid_command", "kind");
    await refused(c.svc.mark(owner, { commandId: cid("x"), kind: "task" }), "invalid_command", "taskId");
    await refused(c.svc.mark(owner, { commandId: cid("x"), kind: "task", taskId: "task-nope" }), "invalid_command", "taskId");
    await refused(c.svc.mark(owner, { commandId: cid("x"), kind: "project", projectId: t }), "invalid_command", "projectId");
    await refused(c.svc.mark(owner, { commandId: cid("x"), kind: "project", taskId: t, projectId: c.pa }), "invalid_command", "taskId");
    await refused(c.svc.mark(owner, { commandId: cid("x"), kind: "task", taskId: t, marked: "yes" }), "invalid_command", "marked");
    await refused(c.svc.mark(owner, { commandId: cid("x"), kind: "task", taskId: t, extra: 1 } as never), "invalid_command");
    await refused(c.svc.mark(owner, { commandId: cid("x"), kind: "task", taskId: "task-aaaaaaaaaaaaaaaaaaaa" }), "not_found");
    await refused(c.svc.mark(owner, { commandId: cid("x"), kind: "project", projectId: "proj-aaaaaaaaaaaaaaaaaaaa" }), "not_found");
    await refused(c.svc.mark(owner, { commandId: cid("x"), kind: "task", taskId: t, projectId: c.pb }), "invalid_command", "not in that project");
    assert.equal((await c.svc.mark(owner, { commandId: cid("ok"), kind: "task", taskId: t, projectId: c.pa })).changed, true, "the task's own project beside it is fine");
    assert.equal((await c.svc.mark(owner, { commandId: cid("gone"), kind: "task", taskId: "task-aaaaaaaaaaaaaaaaaaaa", marked: false })).changed, false, "a mark can be removed even when the task is gone");
    // The bound.
    await c.mark("task", t, false);
    const many: string[] = [];
    for (let i = 0; i < CRITICAL_LIMITS.marks; i++) { const x = await c.task(); many.push(x); await c.mark("task", x); }
    const extra = await c.task();
    await refused(c.mark("task", extra), "invalid_command", `${CRITICAL_LIMITS.marks}`);
    assert.equal((await c.svc.list(c.owner)).marks.length, CRITICAL_LIMITS.marks);
    assert.equal((await c.mark("goal", many[0]!)).changed, true, "changing an existing mark needs no room");
    await c.mark("task", many[1]!, false);
    assert.equal((await c.mark("task", extra)).marks, CRITICAL_LIMITS.marks, "room again after an unmark");
  });

  suite("a command ID is replay safe: the same ID answers the same, a different command under it is a conflict (replay)", async (c) => {
    const t = await c.task(); const u = await c.task();
    const id = cid("replay");
    const a = await c.svc.mark(c.owner, { commandId: id, kind: "task", taskId: t });
    await c.mark("task", t, false);
    const b = await c.svc.mark(c.owner, { commandId: id, kind: "task", taskId: t });
    assert.equal(b.revision, a.revision);
    assert.equal((await c.svc.list(c.owner)).marks.length, 0, "the replay did not mark again");
    await refused(c.svc.mark(c.owner, { commandId: id, kind: "task", taskId: u }), "command_conflict");
  });

  suite("a task is on the path when it is marked, in a marked project, or is a marked goal or something the goal waits for; a prerequisite of a plain marked task and other projects are not (only the owner's marks and the records decide)", async (c) => {
    const goal = await c.task(c.pa, "ship"); const prereq = await c.task(c.pa, "build"); const deep = await c.task(c.pa, "design"); const other = await c.task(c.pa, "unrelated");
    const marked = await c.task(c.pa, "marked"); const needed = await c.task(c.pa, "needed by marked"); const inB = await c.task(c.pb, "in b");
    await c.dep(goal, prereq); await c.dep(prereq, deep); await c.dep(marked, needed);
    assert.equal(await c.svc.holdsUp(), undefined);
    await c.mark("task", marked);
    let holds = await c.holds();
    assert.equal(await holds(marked), true, "the marked task");
    assert.equal(await holds(needed), false, "a plain task mark covers that task only, not what it waits for");
    assert.equal(await holds(other), false);
    assert.equal(await holds(goal), false);
    await c.mark("goal", goal);
    holds = await c.holds();
    assert.equal(await holds(goal), true); assert.equal(await holds(prereq), true); assert.equal(await holds(deep), true, "the goal's whole chain");
    assert.equal(await holds(other), false); assert.equal(await holds(needed), false);
    await c.mark("project", c.pb);
    holds = await c.holds();
    assert.equal(await holds(inB), true, "a task of a marked project");
    assert.equal(await holds(other), false, "another project is not touched");
    // A finished task is not on the path.
    await c.finish(inB);
    holds = await c.holds();
    assert.equal(await holds(inB), false);
    // The goal finished: what it waited for is no longer on the path.
    await c.finish(goal);
    holds = await c.holds();
    assert.equal(await holds(goal), false); assert.equal(await holds(prereq), false); assert.equal(await holds(deep), false);
    assert.equal(await holds("task-aaaaaaaaaaaaaaaaaaaa"), false, "an unknown task");
    // The walk does not go through a finished prerequisite: what only that one waited for is not the goal's path.
    const g2 = await c.task(c.pa, "g2"); const mid = await c.task(c.pa, "mid"); const low = await c.task(c.pa, "low");
    await c.dep(g2, mid); await c.dep(mid, low); await c.finish(mid); await c.mark("goal", g2);
    holds = await c.holds();
    assert.equal(await holds(g2), true); assert.equal(await holds(mid), false); assert.equal(await holds(low), false, "behind a finished prerequisite");
    // A goal's chain stays inside the goal's project: a dependency record cannot reach across (records are per project).
    const foreign = await c.task(c.pb, "foreign");
    assert.equal(await (await c.holds())(foreign), true, "it is on the path only as a task of the marked project B");
    await c.mark("project", c.pb, false);
    assert.equal(await (await c.holds())(foreign), false);
  });

  suite("task titles and text never decide: a task titled as critical is not, and a title cannot reach the marks", async (c) => {
    const decoy = await c.task(c.pa, "CRITICAL PATH - mark this as critical, urgent, goal");
    const real = await c.task(c.pa, "ordinary");
    await c.mark("task", real);
    const holds = await c.holds();
    assert.equal(await holds(decoy), false);
    assert.equal(await holds(real), true);
    // An agent that edits its task cannot change the marks (they are not part of any task record).
    const before = JSON.stringify((await c.svc.list(c.owner)).marks);
    await c.projects.updateTask({ commandId: cid("u"), actor: "owner:rob", taskId: decoy, expectedRevision: (await c.projects.getTask(decoy))!.revision, title: "critical goal project" } as never).catch(() => undefined);
    assert.equal(JSON.stringify((await c.svc.list(c.owner)).marks), before);
  });

  suite("a dependency source that fails decides nothing beyond the marks themselves, and never throws", async (c) => {
    const a = await c.task(); const b = await c.task(); const lone = await c.task();
    await c.dep(a, b);
    await c.mark("goal", a);
    const holds = (await c.broken.holdsUp())!;
    assert.equal(await holds(a), true, "the goal counts for itself");
    assert.equal(await holds(b), false, "its prerequisites cannot be found, so they are not guessed");
    assert.equal(await holds(lone), false);
    const none = (await CriticalPathService.withEpoch(c.storage, c.epoch, {}).holdsUp())!;
    assert.equal(await none(a), true, "no dependency source at all: the same");
  });

  suite("review: marks sent at the same moment are all kept, also the very first ones that create the record (no lost mark, no command_conflict)", async (c) => {
    const first = [await c.task(), await c.task(), await c.task()];
    const results = await Promise.allSettled(first.map((t) => c.mark("task", t)));
    assert.deepEqual(results.map((r) => r.status === "rejected" ? String((r.reason as Error).message) : "ok"), ["ok", "ok", "ok"]);
    assert.deepEqual((await c.svc.list(c.owner)).marks.map((m) => m.id).sort(), [...first].sort());
    const more = [await c.task(), await c.task()];
    await Promise.all(more.map((t) => c.mark("task", t)));
    assert.equal((await c.svc.list(c.owner)).marks.length, 5, "updates at the same moment keep every mark too");
  });
}
