import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { EventService } from "../events/events.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { DEPENDENCY_LIMITS, DependencyService, type NewDependency, type SearchJudge } from "./index.js";

// Card L04d: a recorded search of the task's own project is made again by the controller, with the rights its recorder has now, instead of waiting for a worker that cannot see the controller's records.

after(stopServer);

const options = { clock: () => "2026-11-17T09:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, message?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (message !== undefined) assert.match(error.message, message); return true; });
};
const H = (s: string): string => createHash("sha256").update(s).digest("hex");

for (const backend of backends) {
  interface Ctx {
    deps: DependencyService; plain: DependencyService; judge: SearchJudge & { digests: number; floor?: number | undefined; failDigest?: boolean };
    principals: PrincipalService; desks: DeskService; owner: Principal; ann: Principal; ben: Principal; a: string; b: string; task: string;
    note(by: Principal, title: string, body: string, extra?: Record<string, unknown>): Promise<string>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "T" })).id;
        const agent = async (nm: string, g: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const ann = await agent("ann", [{ action: "attempt.work", project: a }, { action: "desk.write", project: a }, { action: "desk.read", project: a }, { action: "desk.read", project: b }, { action: "attempt.work", project: b }]);
        const ben = await agent("ben", [{ action: "desk.write", project: a }, { action: "desk.read", project: a }]);
        const desks = DeskService.withEpoch(world.storage, epoch, options);
        const retrieval = RetrievalService.withEpoch(world.storage, epoch, desks, HistoryService.withEpoch(world.storage, epoch, options), options);
        const events = EventService.withEpoch(world.storage, epoch, options);
        const judge: Ctx["judge"] = {
          digests: 0,
          reader: (id) => principals.current(id),
          digest: async (reader, projectId, query) => { judge.digests++; if (judge.failDigest === true) throw new Error("disk on fire"); return (await retrieval.searchDigest(reader, { projectId, query })).hash; },
          position: async (projectId) => { const at = await events.since(`project:${projectId}`, Number.MAX_SAFE_INTEGER, 1); return { next: at.head, floor: judge.floor ?? at.floor }; },
        };
        await body({
          deps: DependencyService.withEpoch(world.storage, epoch, { ...options, searches: judge }), plain: DependencyService.withEpoch(world.storage, epoch, options), judge,
          principals, desks, owner, ann, ben, a, b, task,
          note: async (by, title, text, extra = {}) => (await desks.write(by, { commandId: cid("w"), projectId: a, kind: "note", title, body: text, visibility: "shared", status: "accepted", ...extra } as never)).id,
        });
      } finally { await world.close(); }
    });
  const rec = (c: Ctx, dependencies: NewDependency[], by = c.ann, deps = c.deps) => deps.record(by, { commandId: cid("r"), taskId: c.task, dependencies });
  const status = async (c: Ctx, by: Principal = c.ann, observations = {}): Promise<Record<string, string>> => Object.fromEntries((await c.deps.check(by, c.task, observations)).map((r) => [r.key, r.status]));

  suite("a recorded search is made again by the controller: unchanged while it finds the same, changed when a matching record is added, whatever a worker claims", async (c) => {
    await c.note(c.ann, "Compost plan", "turn the compost every week");
    const dep = await c.deps.searchDependency(c.ann, { projectId: c.a, query: "compost" });
    assert.deepEqual([dep.kind, dep.key, dep.scope, dep.cursor], ["search", "compost", { projectId: c.a, query: "compost" }, 1]);
    assert.match(dep.hash!, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(await rec(c, [dep]), { recorded: 1 });
    const entry = (await c.deps.get(c.ann, c.task))!.entries[0]!;
    assert.equal(entry.reader, "agent:ann", "the controller names who made the search");
    assert.deepEqual(await status(c), { compost: "unchanged" }, "made again, not left unknown");
    // A worker's word does not override the controller's own records.
    assert.deepEqual(await status(c, c.ann, { [entry.id]: { hash: H("something else"), cursorFloor: 1 } }), { compost: "unchanged" });
    await c.note(c.ben, "Compost bins", "the compost bins moved");
    const after = await c.deps.check(c.ann, c.task, { [entry.id]: { hash: dep.hash!, cursorFloor: 1 } });
    assert.deepEqual(after.map((r) => [r.key, r.status, r.detail]), [["compost", "changed", "the results differ"]], "a worker claiming the old results does not hide a new hit");
    // A hit whose text is edited (same record, same place in the list) is a change too.
    const rhubarb = await c.note(c.ann, "Rhubarb", "rhubarb by the fence", { status: "draft" });
    await rec(c, [await c.deps.searchDependency(c.ann, { projectId: c.a, query: "rhubarb", key: "rhubarb" })]);
    assert.equal((await status(c))["rhubarb"], "unchanged");
    await c.desks.revise(c.ann, { commandId: cid("rv"), recordId: rhubarb, expectedRevision: 1, body: "rhubarb by the shed" });
    assert.equal((await status(c))["rhubarb"], "changed", "the same hit with other text is not the same result");
    // Without the port the same manifest is judged as before this card: a worker's observation, else unknown.
    assert.ok((await c.plain.check(c.ann, c.task)).every((r) => r.status === "unknown"));
  });

  suite("the search is made again with its recorder's rights: the owner checking sees the agent's view, and a record the agent cannot read changes nothing", async (c) => {
    await c.note(c.ann, "Seeds", "order tomato seeds");
    await rec(c, [await c.deps.searchDependency(c.ann, { projectId: c.a, query: "tomato" })]);
    // Ben's private scratch matches, but Ann may not read it: her search does not find it, so nothing changed for her.
    const scratch = await c.note(c.ben, "Tomato scratch", "tomato thoughts", { visibility: "private", status: "draft" });
    assert.deepEqual(await status(c, c.owner), { tomato: "unchanged" }, "the owner, who reads everything, still gets the recorder's view");
    // The same words searched by the owner are a different search: each is made again with its own recorder's rights, not shared between them.
    await rec(c, [await c.deps.searchDependency(c.owner, { projectId: c.a, query: "tomato", key: "owner tomato" })], c.owner);
    assert.deepEqual(await status(c, c.owner), { tomato: "unchanged", "owner tomato": "unchanged" }, "each found the same as it did for its own recorder");
    await c.desks.revise(c.ben, { commandId: cid("rv"), recordId: scratch, expectedRevision: 1, body: "tomato thoughts, revised" });
    assert.deepEqual(await status(c, c.owner), { tomato: "unchanged", "owner tomato": "changed" });
    // A recorder that is no longer active cannot be searched for: unknown, never unchanged.
    const got = await c.principals.get("agent:ann");
    await c.principals.disable(c.owner, { commandId: cid("d"), principalId: "agent:ann", expectedRevision: got!.revision });
    const out = (await c.deps.check(c.owner, c.task)).filter((r) => r.key === "tomato");
    assert.deepEqual(out.map((r) => [r.status, r.detail]), [["unknown", "the search could not be made again with the rights of whoever made it"]]);
  });

  suite("recording a search is checked like a record: the hash must be what it finds now, the position one the stream reached, and nobody names the reader", async (c) => {
    await c.note(c.ann, "Mulch", "mulch the beds");
    const dep = await c.deps.searchDependency(c.ann, { projectId: c.a, query: "mulch" });
    await refuses("invalid_command", () => rec(c, [{ ...dep, hash: H("not it") }]), /what this search finds now/);
    await refuses("invalid_command", () => rec(c, [{ ...dep, cursor: 99 }]), /past the project's event position/);
    await refuses("invalid_command", () => rec(c, [{ ...dep, reader: "owner:rob" } as never]));
    // The owner's digest of the same words is the owner's view, recorded under the owner.
    const mine = await c.deps.searchDependency(c.owner, { projectId: c.a, query: "mulch", key: "owner mulch" });
    await rec(c, [mine], c.owner);
    assert.equal((await c.deps.get(c.owner, c.task))!.entries.find((e) => e.key === "owner mulch")!.reader, "owner:rob");
    await refuses("invalid_command", () => c.deps.searchDependency(c.ann, { projectId: c.a, query: "m" }));
    await refuses("invalid_command", () => c.deps.searchDependency(c.ann, { projectId: c.a, query: "mulch", key: "two\nlines" }));
    await refuses("unavailable", () => c.plain.searchDependency(c.ann, { projectId: c.a, query: "mulch" }));
  });

  suite("a search made before retention cut the project's events is cursor-expired; one the controller cannot make, or recorded before this card, is unknown", async (c) => {
    await c.note(c.ann, "Water", "water the beans");
    await rec(c, [await c.deps.searchDependency(c.ann, { projectId: c.a, query: "water" })]);
    c.judge.floor = 5;
    assert.deepEqual(await status(c), { water: "cursor-expired" });
    c.judge.floor = undefined;
    c.judge.failDigest = true;
    assert.deepEqual(await status(c), { water: "unknown" }, "a failing search is unknown and the check does not throw");
    c.judge.failDigest = false;
    // Recorded through a controller that did not make searches again: no reader, so not repeated.
    await rec(c, [{ kind: "search", key: "old", scope: { query: "beans" }, cursor: 1, hash: H("whatever") }], c.ann, c.plain);
    const out = Object.fromEntries((await c.deps.check(c.ann, c.task)).map((r) => [r.key, r.detail]));
    assert.match(out["old"]!, /recorded before the controller made searches again/);
  });

  suite("first review: who may ask what to record, a recorder's narrowed rights, a superseded hit, a task credential's search and the exact retention boundary", async (c) => {
    // The answer carries the project's event position: only someone who could rely on a search of that project gets it, with one refusal for a project that does not exist.
    const eve = await c.principals.authenticate((await c.principals.issueCredential(c.owner, (await c.principals.enroll(c.owner, { commandId: cid("e"), kind: "agent", name: "eve", grants: [] })).id)).token);
    await refuses("forbidden", () => c.deps.searchDependency(eve, { projectId: c.a, query: "shed" }));
    await refuses("forbidden", () => c.deps.searchDependency(eve, { projectId: "proj-aaaaaaaaaaaaaaaaaaaa", query: "shed" }));
    const scoped: Principal = { ...c.ann, taskScope: { taskId: c.task, projectId: c.a } };
    await refuses("forbidden", () => c.deps.searchDependency(scoped, { projectId: c.b, query: "shed" }), /may not record a search of that project/);
    assert.equal((await c.deps.searchDependency(c.ann, { projectId: c.b, query: "shed" })).kind, "search", "ann herself reads project B");
    // A right to work one task of the project (granted by a decision; built here as the grant service would load it) is enough, and only in that project.
    const narrow: Principal = { ...eve, grants: [{ action: "attempt.work", project: c.a, resource: { kind: "task", id: c.task } }] as unknown as Principal["grants"] };
    assert.equal((await c.deps.searchDependency(narrow, { projectId: c.a, query: "shed" })).kind, "search");
    await refuses("forbidden", () => c.deps.searchDependency(narrow, { projectId: c.b, query: "shed" }));
    assert.equal((await c.deps.searchDependency(c.owner, { projectId: c.b, query: "shed" })).kind, "search");

    // A task credential's search is recorded under its agent and found unchanged while nothing changed.
    await c.note(c.ben, "Hedge", "trim the hedge in spring");
    const hedge = await c.deps.searchDependency(scoped, { projectId: c.a, query: "hedge" });
    await rec(c, [hedge], scoped);
    assert.equal((await c.deps.get(c.owner, c.task))!.entries.find((e) => e.key === "hedge")!.reader, "agent:ann");
    assert.equal((await status(c, c.owner))["hedge"], "unchanged");
    // Ann's right to read the project narrows: the note she found is no longer hers to find, so the results differ (never unchanged).
    const got = await c.principals.get("agent:ann");
    await c.principals.setGrants(c.owner, { commandId: cid("g"), principalId: "agent:ann", expectedRevision: got!.revision, grants: [{ action: "attempt.work", project: c.a }, { action: "desk.write", project: c.a }] });
    assert.equal((await status(c, c.owner))["hedge"], "changed");

    // A hit superseded by a record that does not match: the old one still matches word for word, but it is no longer current.
    const owner = c.owner;
    const old = await c.note(c.ben, "Pond", "clean the pond filter");
    const pond = await c.deps.searchDependency(owner, { projectId: c.a, query: "pond filter" });
    await rec(c, [pond], owner);
    assert.equal((await status(c, owner))["pond filter"], "unchanged");
    await c.note(c.ben, "Water feature", "replaced by a fountain", { supersedes: old });
    assert.equal((await status(c, owner))["pond filter"], "changed", "a superseded hit is not the same result");

    // Retention: cut exactly at the search's position keeps every event after it; one further is expired.
    c.judge.floor = pond.cursor!;
    assert.equal((await status(c, owner))["pond filter"], "changed", "not expired at the exact boundary");
    c.judge.floor = pond.cursor! + 1;
    assert.equal((await status(c, owner))["pond filter"], "cursor-expired");
  });

  suite("a search of another project stays the worker's to observe, and one check makes at most ten searches, the same one once", async (c) => {
    await c.note(c.ann, "Shed", "paint the shed");
    await rec(c, [{ kind: "search", key: "elsewhere", scope: { projectId: c.b, query: "shed" }, cursor: 3, hash: H("r") }]);
    const id = (await c.deps.get(c.ann, c.task))!.entries[0]!.id;
    assert.equal((await c.deps.get(c.ann, c.task))!.entries[0]!.reader, undefined, "not the controller's to judge, so no reader");
    assert.deepEqual(await status(c, c.ann, { [id]: { hash: H("r"), cursorFloor: 1 } }), { elsewhere: "unchanged" }, "judged from the worker's observation, as before");
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo"];
    const deps = await Promise.all(words.map((w) => c.deps.searchDependency(c.ann, { projectId: c.a, query: w })));
    await rec(c, [...deps, { ...deps[0]!, key: "alpha again" }]);
    c.judge.digests = 0;
    const out = await c.deps.check(c.ann, c.task);
    assert.equal(c.judge.digests, DEPENDENCY_LIMITS.searches, "at most ten searches made again, the repeated query once");
    const query = (key: string): string => (key === "alpha again" ? "alpha" : key);
    const mine = out.filter((r) => r.key !== "elsewhere");
    const made = new Set(mine.filter((r) => r.status === "unchanged").map((r) => query(r.key)));
    const left = mine.filter((r) => r.status === "unknown");
    assert.equal(made.size, DEPENDENCY_LIMITS.searches, "ten different searches made again and found unchanged");
    assert.equal(made.size + new Set(left.map((r) => query(r.key))).size, words.length, "the eleventh is left unknown, and nothing else");
    assert.ok(left.length >= 1 && left.every((r) => r.detail === `more than ${DEPENDENCY_LIMITS.searches} searches were recorded; this one was not repeated`), JSON.stringify(left));
    assert.ok(mine.every((r) => r.status === "unchanged" || r.status === "unknown"));
  });
}
