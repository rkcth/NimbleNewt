import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FaultInjectingStorage } from "../storage/faults.js";
import { MemoryStorage } from "../storage/memory.js";
import { PostgresStorage } from "../storage/postgres/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { SqliteStorage, SqliteWorkerStorage } from "../storage/sqlite/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { DomainError, TRANSITIONS, derivedId, isDomainError, type DomainErrorCode, type TaskState } from "./index.js";
import { ProjectService } from "./service.js";

let serverPromise: Promise<TestServer> | undefined;
const server = (): Promise<TestServer> => (serverPromise ??= startTestServer());
after(async () => { if (serverPromise !== undefined) await (await serverPromise).stop(); });

interface World { readonly storage: ControllerStorage; close(): Promise<void> }
const backends: { name: string; open(): Promise<World> }[] = [
  { name: "reference store", open: async () => { const storage = new MemoryStorage(); return { storage, close: () => storage.close() }; } },
  { name: "SQLite", open: async () => {
    const dir = mkdtempSync(join(tmpdir(), "nn-domain-"));
    const storage = await SqliteStorage.open({ path: join(dir, "c.sqlite") });
    return { storage, close: async () => { await storage.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
  } },
  { name: "SQLite on a worker thread", open: async () => {
    const dir = mkdtempSync(join(tmpdir(), "nn-domain-"));
    const storage = await SqliteWorkerStorage.open({ path: join(dir, "c.sqlite") });
    return { storage, close: async () => { await storage.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
  } },
  { name: "PostgreSQL", open: async () => {
    const s = await server();
    const schema = `domain_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const storage = await PostgresStorage.open({ connectionString: s.url(), schema });
    return { storage, close: async () => { await storage.close(); await withClient(s.url(), async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } },
];

const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    check?.(error);
    return true;
  });
};
const T = "2026-10-20T10:00:00.000Z";
const fast = { clock: () => T, pause: async () => undefined };
const me = "rob";
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  const suite = (name: string, body: (svc: ProjectService, world: World) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try { await body(await ProjectService.open(world.storage, { holder: "c1", ...fast }), world); } finally { await world.close(); }
    });
  const audits = async (world: World) => (await world.storage.listAudit({ afterSeq: 0, limit: 1000 })).length;

  suite("a project can start without a repository, and a task can exist without one; both can get one later", async (svc) => {
    const p = await svc.createProject({ commandId: cid("p"), actor: me, name: "Garden", goal: "Plan the beds" });
    assert.deepEqual([p.revision, p.replayed], [1, false]);
    const project = (await svc.getProject(p.id))!;
    assert.deepEqual([project.state, project.repositories, project.createdBy, project.goal], ["active", [], me, "Plan the beds"]);
    const t = await svc.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title: "Buy seeds" });
    const task = (await svc.getTask(t.id))!;
    assert.deepEqual([task.state, task.projectId, task.description, "repositoryId" in task], ["proposed", p.id, "", false]);
    const withRepo = await svc.updateProject({ commandId: cid("u"), actor: me, projectId: p.id, expectedRevision: 1, addRepositories: [{ id: "notes", location: "/srv/notes", label: "Notes" }] });
    assert.equal(withRepo.revision, 2);
    const attached = await svc.updateTask({ commandId: cid("a"), actor: me, taskId: t.id, expectedRevision: 1, repositoryId: "notes" });
    assert.equal((await svc.getTask(t.id))!.repositoryId, "notes");
    const detached = await svc.updateTask({ commandId: cid("d"), actor: me, taskId: t.id, expectedRevision: attached.revision, repositoryId: null });
    assert.deepEqual([detached.revision, "repositoryId" in (await svc.getTask(t.id))!], [3, false]);
    const unchanged = await svc.updateTask({ commandId: cid("title"), actor: me, taskId: t.id, expectedRevision: 3, title: "Buy more seeds" });
    assert.deepEqual([unchanged.revision, (await svc.getTask(t.id))!.title, "repositoryId" in (await svc.getTask(t.id))!], [4, "Buy more seeds", false], "editing the title keeps the absent repository absent");
  });

  suite("a repeated command applies once, and answers with the first result even after the record has moved on", async (svc, world) => {
    const command = { commandId: "make-garden", actor: me, name: "Garden", goal: "g" };
    const first = await svc.createProject(command);
    const again = await svc.createProject(command);
    assert.deepEqual(again, { ...first, replayed: true });
    assert.equal(first.id, derivedId("proj", "make-garden"), "the identity comes from the command ID");
    assert.equal(await audits(world), 1);
    const edit = { commandId: "rename", actor: me, projectId: first.id, expectedRevision: 1, name: "Allotment" };
    const edited = await svc.updateProject(edit);
    await svc.updateProject({ commandId: "rename-2", actor: me, projectId: first.id, expectedRevision: 2, name: "Plot" });
    const repeated = await svc.updateProject(edit); // the record is at revision 3 now; the command is still recognised as applied
    assert.deepEqual(repeated, { id: first.id, revision: edited.revision, replayed: true });
    assert.equal((await svc.getProject(first.id))!.name, "Plot", "a repeat did not apply again");
    assert.equal(await audits(world), 3);
  });

  suite("a command ID reused for a different command is a conflict, whatever the difference, and changes nothing", async (svc, world) => {
    const p = await svc.createProject({ commandId: "c1", actor: me, name: "A" });
    await refuses("command_conflict", () => svc.createProject({ commandId: "c1", actor: me, name: "B" }));
    await refuses("command_conflict", () => svc.createProject({ commandId: "c1", actor: "someone-else", name: "A" }));
    await refuses("command_conflict", () => svc.createProject({ commandId: "c1", actor: me, name: "A", goal: "now with a goal" }));
    await refuses("command_conflict", () => svc.createTask({ commandId: "c1", actor: me, projectId: p.id, title: "t" }), (e) => assert.match(e.message, /different command|not a project command/));
    await refuses("command_conflict", () => svc.updateProject({ commandId: "c1", actor: me, projectId: p.id, expectedRevision: 1, name: "C" }));
    assert.deepEqual([(await svc.getProject(p.id))!.name, (await svc.getProject(p.id))!.revision, await audits(world)], ["A", 1, 1]);
  });

  suite("a stale revision is rejected with the current one, and of two commands on the same revision exactly one wins", async (svc, world) => {
    const p = await svc.createProject({ commandId: cid("p"), actor: me, name: "A" });
    await svc.updateProject({ commandId: cid("u"), actor: me, projectId: p.id, expectedRevision: 1, name: "B" });
    await refuses("stale_revision", () => svc.updateProject({ commandId: cid("u"), actor: me, projectId: p.id, expectedRevision: 1, name: "C" }), (e) => assert.equal(e.currentRevision, 2));
    await refuses("stale_revision", () => svc.updateProject({ commandId: cid("u"), actor: me, projectId: p.id, expectedRevision: 9, name: "C" }), (e) => assert.equal(e.currentRevision, 2));
    assert.equal((await svc.getProject(p.id))!.name, "B");
    const before = await audits(world);
    const results = await Promise.allSettled([
      svc.updateProject({ commandId: cid("race"), actor: me, projectId: p.id, expectedRevision: 2, name: "left" }),
      svc.updateProject({ commandId: cid("race"), actor: me, projectId: p.id, expectedRevision: 2, name: "right" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(isDomainError(lost.reason, "stale_revision") && lost.reason.currentRevision === 3, String(lost.reason));
    assert.equal(await audits(world), before + 1);
    assert.ok(["left", "right"].includes((await svc.getProject(p.id))!.name));
  });

  suite("duplicates sent at the same moment as the original are all answered with its result, never with a stale-revision error", async (svc) => {
    const p = await svc.createProject({ commandId: cid("p"), actor: me, name: "A" });
    let revision = p.revision;
    for (let round = 0; round < 8; round++) {
      const command = { commandId: cid("dup"), actor: me, projectId: p.id, expectedRevision: revision, name: `N${round}` };
      const results = await Promise.allSettled([svc.updateProject(command), svc.updateProject(command), svc.updateProject(command), svc.updateProject(command)]);
      for (const r of results) assert.equal(r.status, "fulfilled", r.status === "rejected" ? String(r.reason) : "");
      const values = results.map((r) => (r as PromiseFulfilledResult<{ revision: number; replayed: boolean }>).value);
      assert.equal(new Set(values.map((v) => v.revision)).size, 1, "every copy reports the same revision");
      assert.equal(values.filter((v) => !v.replayed).length, 1, "exactly one copy applied it");
      revision = values[0]!.revision;
    }
    assert.equal((await svc.getProject(p.id))!.revision, 9, "eight updates were applied, once each");
    const t = await svc.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title: "T" });
    const move = { commandId: cid("dup"), actor: me, taskId: t.id, expectedRevision: 1, to: "ready" as const };
    const moved = await Promise.all([svc.transitionTask(move), svc.transitionTask(move), svc.transitionTask(move)]);
    assert.deepEqual(new Set(moved.map((m) => m.revision)), new Set([2]));
  });

  suite("a duplicate that read its state after the original had committed is answered, not refused", async (svc, world) => {
    const p = await svc.createProject({ commandId: cid("p"), actor: me, name: "A" });
    const command = { commandId: "late-duplicate", actor: me, projectId: p.id, expectedRevision: 1, name: "B" };
    const first = await svc.updateProject(command);
    // The second submission's first look for a record of the command finds none (it asked just before the original committed); everything
    // after that sees the committed state, which is what the interleaving above produces.
    let hidden = true;
    const blind = new Proxy(world.storage, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver) as unknown;
        if (name !== "getOperation" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
        return async (id: string) => { if (hidden) { hidden = false; return undefined; } return (value as (id: string) => Promise<unknown>).call(target, id); };
      },
    }) as ControllerStorage;
    const second = ProjectService.withEpoch(blind, svc.epoch, fast);
    assert.deepEqual(await second.updateProject(command), { ...first, replayed: true });
    assert.equal(hidden, false);
    assert.equal(await audits(world), 2, "applied once");
    // A genuinely different command with the same ID is still a conflict on that path.
    hidden = true;
    await refuses("command_conflict", () => second.updateProject({ ...command, name: "C" }));
  });

  suite("services of one controller can share the epoch it acquired, and a deposed controller's services all stop", async (svc, world) => {
    const sibling = ProjectService.withEpoch(world.storage, svc.epoch, fast);
    const p = await svc.createProject({ commandId: cid("p"), actor: me, name: "A" });
    assert.equal((await sibling.updateProject({ commandId: cid("u"), actor: me, projectId: p.id, expectedRevision: 1, name: "B" })).revision, 2);
    await ProjectService.open(world.storage, { holder: "c2", ...fast });
    await refuses("stale_epoch", () => svc.createProject({ commandId: cid("x"), actor: me, name: "C" }));
    await refuses("stale_epoch", () => sibling.createProject({ commandId: cid("x"), actor: me, name: "C" }));
    assert.throws(() => ProjectService.withEpoch(world.storage, 0, fast), (e) => isDomainError(e, "invalid_command"));
  });

  suite("a task follows its lifecycle: only allowed moves, final states are final, a finished task cannot be edited", async (svc) => {
    const p = await svc.createProject({ commandId: cid("p"), actor: me, name: "A" });
    const t = await svc.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title: "T" });
    let revision = t.revision;
    const move = async (to: TaskState) => { revision = (await svc.transitionTask({ commandId: cid("m"), actor: me, taskId: t.id, expectedRevision: revision, to })).revision; };
    await refuses("invalid_transition", () => svc.transitionTask({ commandId: cid("m"), actor: me, taskId: t.id, expectedRevision: revision, to: "done" }), (e) => assert.match(e.message, /proposed to done/));
    await refuses("invalid_transition", () => svc.transitionTask({ commandId: cid("m"), actor: me, taskId: t.id, expectedRevision: revision, to: "proposed" }));
    for (const to of ["ready", "in_progress", "blocked", "in_progress", "done"] as const) await move(to);
    assert.equal((await svc.getTask(t.id))!.state, "done");
    for (const to of Object.keys(TRANSITIONS) as TaskState[]) await refuses("invalid_transition", () => svc.transitionTask({ commandId: cid("m"), actor: me, taskId: t.id, expectedRevision: revision, to }), (e) => assert.match(e.message, /final/));
    await refuses("invalid_command", () => svc.updateTask({ commandId: cid("e"), actor: me, taskId: t.id, expectedRevision: revision, title: "late edit" }), (e) => assert.match(e.message, /no longer be edited/));
    const c = await svc.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title: "C" });
    await svc.transitionTask({ commandId: cid("m"), actor: me, taskId: c.id, expectedRevision: c.revision, to: "cancelled" });
    assert.equal((await svc.getTask(c.id))!.state, "cancelled");
    // every pair is checked against the table
    for (const [from, allowed] of Object.entries(TRANSITIONS)) for (const to of Object.keys(TRANSITIONS)) assert.equal(allowed.includes(to as TaskState), from !== to && allowed.includes(to as TaskState));
  });

  suite("tasks need an existing, active project and a repository the project has; a repeat of a task command still answers after the project is archived", async (svc) => {
    await refuses("not_found", () => svc.createTask({ commandId: cid("t"), actor: me, projectId: derivedId("proj", "nobody"), title: "T" }));
    const p = await svc.createProject({ commandId: cid("p"), actor: me, name: "A", repositories: [{ id: "main", location: "git@example.org:a/b.git" }] });
    await refuses("invalid_command", () => svc.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title: "T", repositoryId: "other" }), (e) => assert.equal(e.field, "repositoryId"));
    const command = { commandId: "first-task", actor: me, projectId: p.id, title: "T", repositoryId: "main" };
    const t = await svc.createTask(command);
    await svc.updateProject({ commandId: cid("u"), actor: me, projectId: p.id, expectedRevision: 1, state: "archived" });
    await refuses("invalid_command", () => svc.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title: "U" }), (e) => assert.match(e.message, /archived/));
    assert.deepEqual(await svc.createTask(command), { ...t, replayed: true });
    await refuses("invalid_command", () => svc.updateTask({ commandId: cid("e"), actor: me, taskId: t.id, expectedRevision: 1, repositoryId: "gone" }), (e) => assert.equal(e.field, "repositoryId"));
    await svc.updateProject({ commandId: cid("u"), actor: me, projectId: p.id, expectedRevision: 2, state: "active" });
    assert.equal((await svc.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title: "U" })).replayed, false);
  });

  suite("repositories are added, never repeated, never more than the limit", async (svc) => {
    const p = await svc.createProject({ commandId: cid("p"), actor: me, name: "A", repositories: [{ id: "a", location: "/a" }] });
    await refuses("invalid_command", () => svc.updateProject({ commandId: cid("u"), actor: me, projectId: p.id, expectedRevision: 1, addRepositories: [{ id: "a", location: "/other" }] }), (e) => assert.match(e.message, /already has a repository a/));
    await refuses("invalid_command", () => svc.createProject({ commandId: cid("p"), actor: me, name: "B", repositories: [{ id: "x", location: "/x" }, { id: "x", location: "/y" }] }), (e) => assert.match(e.message, /repeats x/));
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, location: `/r${i}` }));
    await refuses("invalid_command", () => svc.updateProject({ commandId: cid("u"), actor: me, projectId: p.id, expectedRevision: 1, addRepositories: many }), (e) => assert.match(e.message, /at most 50/));
    assert.equal((await svc.getProject(p.id))!.repositories.length, 1);
  });

  suite("malformed commands are refused before anything is written, naming the field", async (svc, world) => {
    const p = await svc.createProject({ commandId: cid("p"), actor: me, name: "A" });
    const base = audits(world);
    const bad: [string, () => Promise<unknown>][] = [
      ["name", () => svc.createProject({ commandId: cid("x"), actor: me, name: "" })],
      ["name", () => svc.createProject({ commandId: cid("x"), actor: me, name: "   " })],
      ["name", () => svc.createProject({ commandId: cid("x"), actor: me, name: "line\nbreak" })],
      ["name", () => svc.createProject({ commandId: cid("x"), actor: me, name: "x".repeat(121) })],
      ["name", () => svc.createProject({ commandId: cid("x"), actor: me, name: "bad \ud800 surrogate" })],
      ["name", () => svc.createProject({ commandId: cid("x"), actor: me, name: 5 as unknown as string })],
      ["goal", () => svc.createProject({ commandId: cid("x"), actor: me, name: "A", goal: "x".repeat(4001) })],
      ["commandId", () => svc.createProject({ commandId: "", actor: me, name: "A" })],
      ["commandId", () => svc.createProject({ commandId: "has space", actor: me, name: "A" })],
      ["commandId", () => svc.createProject({ commandId: "x".repeat(121), actor: me, name: "A" })],
      ["actor", () => svc.createProject({ commandId: cid("x"), actor: "", name: "A" })],
      ["colour", () => svc.createProject({ commandId: cid("x"), actor: me, name: "A", colour: "red" } as never)],
      ["repositories[0].id", () => svc.createProject({ commandId: cid("x"), actor: me, name: "A", repositories: [{ id: "Bad Id", location: "/x" }] })],
      ["repositories[0].location", () => svc.createProject({ commandId: cid("x"), actor: me, name: "A", repositories: [{ id: "ok", location: "" }] })],
      ["repositories[0].extra", () => svc.createProject({ commandId: cid("x"), actor: me, name: "A", repositories: [{ id: "ok", location: "/x", extra: 1 }] as never })],
      ["projectId", () => svc.updateProject({ commandId: cid("x"), actor: me, projectId: "proj-nope", expectedRevision: 1, name: "B" })],
      ["expectedRevision", () => svc.updateProject({ commandId: cid("x"), actor: me, projectId: p.id, expectedRevision: 0, name: "B" })],
      ["expectedRevision", () => svc.updateProject({ commandId: cid("x"), actor: me, projectId: p.id, expectedRevision: 1.5, name: "B" })],
      ["expectedRevision", () => svc.updateProject({ commandId: cid("x"), actor: me, projectId: p.id, name: "B" } as never)],
      ["name", () => svc.updateProject({ commandId: cid("x"), actor: me, projectId: p.id, expectedRevision: 1 })],
      ["state", () => svc.updateProject({ commandId: cid("x"), actor: me, projectId: p.id, expectedRevision: 1, state: "deleted" as never })],
      ["taskId", () => svc.transitionTask({ commandId: cid("x"), actor: me, taskId: p.id, expectedRevision: 1, to: "ready" })],
      ["to", () => svc.transitionTask({ commandId: cid("x"), actor: me, taskId: derivedId("task", "t"), expectedRevision: 1, to: "finished" as never })],
      ["limit", () => svc.listProjects({ limit: 0 })],
    ];
    for (const [field, run] of bad) await refuses("invalid_command", run, (e) => assert.ok(e.field === field || e.message.includes(field), `${field}: ${e.message}`));
    await refuses("invalid_command", async () => svc.createProject(null as never));
    assert.equal(await audits(world), await base, "nothing was written");
    await refuses("not_found", () => svc.updateProject({ commandId: cid("x"), actor: me, projectId: derivedId("proj", "ghost"), expectedRevision: 1, name: "B" }));
    await refuses("not_found", () => svc.transitionTask({ commandId: cid("x"), actor: me, taskId: derivedId("task", "ghost"), expectedRevision: 1, to: "ready" }));
    assert.equal(await svc.getProject(derivedId("proj", "ghost")), undefined);
    assert.equal(await svc.getTask(derivedId("task", "ghost")), undefined);
  });

  suite("text keeps its Unicode and its newlines where allowed", async (svc) => {
    const p = await svc.createProject({ commandId: cid("p"), actor: me, name: "Ünïcode 🌱   项目", goal: "one\ntwo\n\n" });
    const project = (await svc.getProject(p.id))!;
    assert.deepEqual([project.name, project.goal], ["Ünïcode 🌱   项目", "one\ntwo\n\n"]);
    await refuses("invalid_command", () => svc.createProject({ commandId: cid("p"), actor: me, name: "tab\there" }));
  });

  suite("after a takeover the old controller cannot change anything, but a repeat of what it committed is still answered", async (svc, world) => {
    const committed = { commandId: "before-takeover", actor: me, name: "A" };
    const p = await svc.createProject(committed);
    const next = await ProjectService.open(world.storage, { holder: "c2", ...fast });
    assert.equal(next.epoch, svc.epoch + 1);
    await refuses("stale_epoch", () => svc.createProject({ commandId: cid("after"), actor: me, name: "B" }));
    await refuses("stale_epoch", () => svc.updateProject({ commandId: cid("after"), actor: me, projectId: p.id, expectedRevision: 1, name: "C" }));
    assert.deepEqual(await svc.createProject(committed), { ...p, replayed: true });
    assert.equal((await next.createProject({ commandId: cid("new"), actor: me, name: "B" })).replayed, false);
    assert.equal((await next.getProject(p.id))!.name, "A");
  });

  suite("listing: projects and tasks come back in ID order, in pages, and tasks can be filtered by project", async (svc) => {
    const a = await svc.createProject({ commandId: cid("p"), actor: me, name: "A" });
    const b = await svc.createProject({ commandId: cid("p"), actor: me, name: "B" });
    const made: string[] = [];
    for (let i = 0; i < 6; i++) made.push((await svc.createTask({ commandId: cid("t"), actor: me, projectId: i % 3 === 0 ? a.id : b.id, title: `T${i}` })).id);
    const projects = await svc.listProjects({ limit: 10 });
    assert.deepEqual(projects.map((p) => p.id), [a.id, b.id].sort());
    assert.deepEqual((await svc.listProjects({ afterId: projects[0]!.id, limit: 10 })).map((p) => p.id), [projects[1]!.id]);
    const all = await svc.listTasks({ limit: 100 });
    assert.deepEqual(all.items.map((t) => t.id), [...made].sort());
    assert.equal(all.next, undefined);
    const ofA = await svc.listTasks({ projectId: a.id, limit: 100 });
    assert.deepEqual(ofA.items.map((t) => t.title).sort(), ["T0", "T3"]);
    const paged: string[] = [];
    for (let after: string | undefined, guard = 0; guard < 10; guard++) {
      const page = await svc.listTasks({ projectId: b.id, limit: 2, ...(after === undefined ? {} : { afterId: after }) });
      paged.push(...page.items.map((t) => t.title));
      after = page.next;
      if (after === undefined) break;
    }
    assert.deepEqual(paged.sort(), ["T1", "T2", "T4", "T5"]);
  });
}

// ---- failures of the storage underneath ---------------------------------------------------------------------------------------------
test("a commit whose answer was lost is settled by the command ID: applied once, and the caller still gets its result", async () => {
  const inner = new MemoryStorage();
  const faulty = new FaultInjectingStorage(inner, [{ when: "after", kind: "uncertain_commit" }]);
  const svc = await ProjectService.open(faulty, { holder: "c", ...fast });
  const result = await svc.createProject({ commandId: "lost-answer", actor: me, name: "A" });
  assert.deepEqual([result.revision, result.replayed], [1, true], "the retry found the first application and returned its result");
  assert.equal((await inner.listAudit({ afterSeq: 0, limit: 10 })).length, 1);
  assert.equal((await svc.listProjects({ limit: 10 })).length, 1);
});

test("contention that outlasts the retry budget is reported as unavailable, and the same command can be sent again", async () => {
  const inner = new MemoryStorage();
  const faulty = new FaultInjectingStorage(inner, [{ when: "before", kind: "retryable" }, { when: "before", kind: "retryable" }]);
  const svc = await ProjectService.open(faulty, { holder: "c", attempts: 2, ...fast });
  const command = { commandId: "busy", actor: me, name: "A" };
  await refuses("unavailable", () => svc.createProject(command));
  assert.equal((await inner.listAudit({ afterSeq: 0, limit: 10 })).length, 0);
  assert.deepEqual((await svc.createProject(command)).replayed, false);
  assert.equal((await svc.createProject(command)).replayed, true);
});

test("a storage that is gone is reported as unavailable, not as a missing record", async () => {
  const inner = new MemoryStorage();
  const svc = await ProjectService.open(inner, { holder: "c", ...fast });
  await inner.close();
  await refuses("unavailable", () => svc.createProject({ commandId: "gone", actor: me, name: "A" }));
  await refuses("unavailable", () => svc.getProject(derivedId("proj", "x")));
});

test("derived identities are stable, distinct per kind and per command, and well formed", () => {
  const a = derivedId("proj", "same");
  assert.equal(a, derivedId("proj", "same"));
  assert.notEqual(a, derivedId("task", "same").replace("task-", "proj-"));
  assert.notEqual(a, derivedId("proj", "other"));
  assert.match(a, /^proj-[a-z2-7]{20}$/);
  assert.match(derivedId("task", "x".repeat(120)), /^task-[a-z2-7]{20}$/);
  const seen = new Set(Array.from({ length: 5000 }, (_, i) => derivedId("task", `command-${i}`)));
  assert.equal(seen.size, 5000);
});
