import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { API_VERSION } from "../api/index.js";
import type { Principal } from "../security/index.js";
import type { CoordinatorModel, CoordinatorRequest, CoordinatorService } from "./index.js";
import { cid, openWorld, type World } from "./testing/harness.js";

after(stopServer);

const refuses = (code: string) => (e: unknown): boolean => e instanceof DomainError && e.code === code;

for (const backend of backends) {
  /** A model that answers from a function, records the routes it was asked on, and fails on the routes in `down`. */
  const scripted = (reply: (r: CoordinatorRequest) => unknown, down: string[] = []): CoordinatorModel & { routes: string[]; requests: CoordinatorRequest[] } => {
    const m = { routes: [] as string[], requests: [] as CoordinatorRequest[], respond: async (route: string, request: CoordinatorRequest) => { m.routes.push(route); m.requests.push(request); if (down.includes(route)) throw new Error(`${route} is down`); return reply(request); } };
    return m;
  };
  const suite = (name: string, body: (w: World) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const w = await openWorld(backend);
      try { await body(w); } finally { await w.close(); }
    });
  const start = async (c: { service: CoordinatorService; owner: Principal }, routes = ["primary", "backup"]) => {
    const made = await c.service.configure(c.owner, { commandId: cid("cfg"), principalId: "agent:coord", routes });
    assert.equal((await c.service.get(c.owner))!.state, "paused", "set up paused");
    return c.service.setState(c.owner, { commandId: cid("st"), expectedRevision: made.revision, to: "running" });
  };
  const note = async (w: World, projectId: string, title: string, body: string) => {
    const writer = await w.agent(`writer-${cid("n")}`, [{ action: "desk.write", project: projectId }, { action: "desk.read", project: projectId }]);
    return w.desks.write(writer.principal, { commandId: cid("w"), projectId, kind: "note", title, body, visibility: "shared", status: "accepted" } as never);
  };
  const withOwner = async (w: World, model: CoordinatorModel, grants?: never) => { const c = await w.coordinator({ model, ...(grants === undefined ? {} : { grants }) }); return { ...c, owner: w.owner }; };

  suite("lifecycle: set up paused, the owner starts, pauses and stops it; only the owner; a stopped one can only be started", async (w) => {
    const c = await withOwner(w, scripted(() => ({})));
    const a = await w.project("A");
    assert.deepEqual(await c.service.answer(c.owner, { commandId: cid("q"), projectId: a, question: "anything" }), { kind: "unavailable", reason: "the coordinator is not set up" });
    const made = await c.service.configure(c.owner, { commandId: "cfg-1", principalId: "agent:coord", routes: ["p", "b"] });
    assert.deepEqual(await c.service.configure(c.owner, { commandId: "cfg-1", principalId: "agent:coord", routes: ["p", "b"] }), { ...made, replayed: true });
    assert.equal((await c.service.answer(c.owner, { commandId: cid("q"), projectId: a, question: "anything" })).kind, "unavailable");
    const running = await c.service.setState(c.owner, { commandId: cid("s"), expectedRevision: made.revision, to: "running" });
    assert.equal((await c.service.get(c.owner))!.state, "running");
    const paused = await c.service.setState(c.owner, { commandId: cid("s"), expectedRevision: running.revision, to: "paused" });
    assert.deepEqual((await c.service.answer(c.owner, { commandId: cid("q"), projectId: a, question: "anything" })), { kind: "unavailable", reason: "the coordinator is paused" });
    const stopped = await c.service.setState(c.owner, { commandId: cid("s"), expectedRevision: paused.revision, to: "stopped" });
    await assert.rejects(c.service.setState(c.owner, { commandId: cid("s"), expectedRevision: stopped.revision, to: "paused" }), refuses("invalid_command"));
    await assert.rejects(c.service.setState(c.owner, { commandId: cid("s"), expectedRevision: paused.revision, to: "running" }), refuses("stale_revision"));
    const started = await c.service.setState(c.owner, { commandId: cid("s"), expectedRevision: stopped.revision, to: "running" });
    assert.equal(started.revision, stopped.revision + 1);
    await assert.rejects(c.service.setState(c.principal, { commandId: cid("s"), expectedRevision: started.revision, to: "stopped" }), refuses("forbidden"));
    await assert.rejects(c.service.configure(c.owner, { commandId: cid("cfg"), principalId: "ann", routes: ["p"] }), refuses("invalid_command"));
    await assert.rejects(c.service.configure(c.owner, { commandId: cid("cfg"), principalId: "agent:coord", routes: [] }), refuses("invalid_command"));
    await assert.rejects(c.service.configure(c.owner, { commandId: cid("cfg"), principalId: "agent:other", routes: ["p"] }), refuses("stale_revision"));
    const changed = await c.service.configure(c.owner, { commandId: cid("cfg"), principalId: "agent:coord", routes: ["x", "y", "x"], expectedRevision: started.revision });
    assert.deepEqual((await c.service.get(c.owner))!.routes, ["x", "y"]);
    assert.equal(changed.revision, started.revision + 1);
  });

  suite("answers from records with citations and opens no inquiry when records suffice", async (w) => {
    const a = await w.project("A");
    const t = await w.task(a, "T");
    const rec = await note(w, a, "Database choice", "We chose PostgreSQL for the crash-recovery tests.");
    const model = scripted((r) => (r.kind === "answer" ? { kind: "answer", text: "PostgreSQL, for crash recovery.", cites: [r.records[0]!.source] } : {}));
    const c = await withOwner(w, model);
    await start(c);
    await w.assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId: t, owner: { kind: "agent", id: "ann" } });
    const a1 = await c.service.answer(c.owner, { commandId: cid("q"), projectId: a, question: "which database did we choose", taskId: t });
    assert.equal(a1.kind, "answer");
    assert.deepEqual((a1 as unknown as { cites: unknown[] }).cites, [{ kind: "desk-record", id: rec.id }]);
    assert.equal((await w.inquiries.pendingFor(w.owner)).items.length, 0, "records sufficed: no inquiry");
    assert.equal(model.routes[0], "primary");
    // the model is shown only the records, nothing else
    assert.deepEqual(Object.keys(model.requests[0]!).sort(), ["kind", "question", "records"]);
  });

  suite("an answer citing nothing it was shown is not an answer; insufficient records open one inquiry (once per command) when a task is named", async (w) => {
    await w.agent("ann", [{ action: "history.*", project: "*" }]);
    const a = await w.project("A");
    const t = await w.task(a, "T");
    await note(w, a, "Database choice", "We chose PostgreSQL.");
    await w.assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId: t, owner: { kind: "agent", id: "ann" } });
    let mode: "forged" | "insufficient" = "forged";
    const forgedCite = { kind: "answer", text: "made up", cites: [{ kind: "desk-record", id: "dsk-zzzzzzzzzzzzzzzzzzzz" }] };
    const c = await withOwner(w, scripted((r) => (r.kind === "answer" ? (mode === "forged" ? forgedCite : { kind: "insufficient" }) : {})));
    await start(c);
    const forged = await c.service.answer(c.owner, { commandId: "q-1", projectId: a, question: "which database", taskId: t });
    assert.equal(forged.kind, "asked", "a forged citation is no answer, so records were not enough");
    const inquiryId = (forged as { inquiryId: string }).inquiryId;
    const replay = await c.service.answer(c.owner, { commandId: "q-1", projectId: a, question: "which database", taskId: t });
    assert.deepEqual(replay, { kind: "asked", inquiryId, to: "agent:ann", replayed: true });
    assert.equal((await w.inquiries.pendingFor(w.owner)).items.length, 1);
    mode = "insufficient";
    // no records match at all: no model call, and with no task named there is nowhere to ask
    const none = await c.service.answer(c.owner, { commandId: cid("q"), projectId: a, question: "zebra giraffe" });
    assert.equal(none.kind, "insufficient");
    // nothing matched and a task is named: an inquiry, to the owner, from the coordinator
    const asked = await c.service.answer(c.owner, { commandId: cid("q"), projectId: a, question: "zebra giraffe", taskId: t });
    assert.equal(asked.kind, "asked");
    const view = (await w.inquiries.view(w.owner, (asked as { inquiryId: string }).inquiryId))!;
    assert.deepEqual([view.inquiry.asker, view.inquiry.to], ["agent:coord", "agent:ann"], "asked of the task's assignee, not the owner");
    assert.equal((asked as { to: string }).to, "agent:ann");
    // nobody to ask: a task with no assignee and no one named
    const free = await w.task(a, "Free");
    assert.equal((await c.service.answer(c.owner, { commandId: cid("q"), projectId: a, question: "zebra giraffe", taskId: free })).kind, "insufficient");
    const named = await c.service.answer(c.owner, { commandId: cid("q"), projectId: a, question: "zebra giraffe", taskId: free, to: "agent:ann" });
    assert.equal((named as { to: string }).to, "agent:ann");
  });

  suite("routes: the primary, then fallbacks in order, at most four; when all fail the coordinator is unavailable and the controller keeps working", async (w) => {
    const a = await w.project("A");
    await note(w, a, "Database choice", "We chose PostgreSQL.");
    const down = ["primary", "backup"];
    const model = scripted((r) => (r.kind === "answer" ? { kind: "answer", text: "PostgreSQL", cites: [r.records[0]!.source] } : {}), down);
    const c = await withOwner(w, model);
    const running = await start(c, ["primary", "backup", "third"]);
    assert.equal((await c.service.answer(c.owner, { commandId: cid("q"), projectId: a, question: "which database" })).kind, "answer");
    assert.deepEqual(model.routes, ["primary", "backup", "third"]);
    model.routes.length = 0;
    const five = await c.service.configure(c.owner, { commandId: cid("cfg"), principalId: "agent:coord", routes: ["a", "b", "c", "d", "e"], expectedRevision: running.revision });
    void five;
    down.push("a", "b", "c", "d", "e");
    const r = await c.service.answer(c.owner, { commandId: cid("q"), projectId: a, question: "which database" });
    assert.deepEqual(r, { kind: "unavailable", reason: "the coordinator could not be reached on any route" });
    assert.deepEqual(model.routes, ["a", "b", "c", "d"], "four tries at most");
    assert.deepEqual(await c.service.decompose(c.owner, { commandId: cid("d"), projectId: a, outcome: "ship" }), { kind: "unavailable", reason: "the coordinator could not be reached on any route" });
    // the controller works without it: the state API and the owner's chat proposals
    const created = await w.api.handle(w.ownerToken, { v: API_VERSION, op: "task.create", commandId: cid("c"), args: { projectId: a, title: "direct" } });
    assert.ok(created.ok);
    const saved = await w.chat().propose(w.owner, { commandId: cid("pp"), source: "chat", reason: "x", preview: ["Create team"], steps: [{ op: "team.create", args: { name: "core" } }] });
    assert.equal((await w.chat().applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: saved.id })).applied, true);
  });

  const plan = { tasks: [
    { key: "design", title: "Design the schema", description: "tables" },
    { key: "build", title: "Build the migration", dependsOn: ["design"], assignTo: { kind: "agent", id: "ann" } },
    { key: "test", title: "Test the migration", dependsOn: ["build", "design"], assignTo: { kind: "agent", id: "ben" } },
  ] };

  suite("decomposes an outcome into tasks with dependencies as a proposal; nothing exists until the owner applies it; without the grant the owner's apply makes the assignments", async (w) => {
    const a = await w.project("A");
    const model = scripted((r) => (r.kind === "decompose" ? plan : {}));
    const c = await withOwner(w, model);
    await start(c);
    const d = await c.service.decompose(c.owner, { commandId: "dec-1", projectId: a, outcome: "migrate the database" });
    assert.ok("proposalId" in d);
    const done = d as Extract<typeof d, { proposalId: string }>;
    assert.deepEqual([done.tasks, done.assignments], [3, "by-owner"]);
    assert.deepEqual(model.requests[0], { kind: "decompose", outcome: "migrate the database", project: { id: a, name: "A", repositories: ["main"] } });
    assert.equal((await w.projects.listTasks({ projectId: a, limit: 10 })).items.length, 0, "nothing admitted");
    const again = await c.service.decompose(c.owner, { commandId: "dec-1", projectId: a, outcome: "migrate the database" });
    assert.equal((again as { replayed: boolean }).replayed, true);
    const p = (await w.chat().getProposal(w.ownerToken, done.proposalId))!;
    assert.deepEqual(p.steps.filter((s) => s.op === "task.assign").map((s) => s.as), ["owner", "owner"]);
    assert.ok(p.steps.filter((s) => s.op === "task.create").every((s) => s.args["projectId"] === a && s.args["repositoryId"] === "main"), "every created task carries project and repository");
    const applied = await w.chat().applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: done.proposalId });
    assert.equal(applied.applied, true);
    const tasks = (await w.projects.listTasks({ projectId: a, limit: 10 })).items;
    assert.equal(tasks.length, 3);
    const id = (key: string) => applied.results.find((r) => r.key === key)!.id;
    const deps = await w.api.handle(w.ownerToken, { v: 1, op: "dependency.list", args: { taskId: id("test") } });
    assert.ok(deps.ok);
    assert.equal(((deps as unknown as { result: { item: { dependsOn: unknown[] } } }).result.item.dependsOn).length, 2);
    assert.equal((await w.assignments.getAssignment(id("build")))!.owner!.id, "ann");
    assert.equal((await w.assignments.getAssignment(id("test")))!.owner!.id, "ben");
  });

  suite("if the coordinator is granted assignment, its own credential makes the assignments (still only after the owner applies); without a credential that step is not done", async (w) => {
    const a = await w.project("A");
    const model = scripted((r) => (r.kind === "decompose" ? plan : {}));
    const grants = [{ action: "attempt.work", project: "*" }, { action: "assignment.manage", project: a }] as never;
    const c = await withOwner(w, model, grants);
    await start(c);
    const d = (await c.service.decompose(c.owner, { commandId: cid("d"), projectId: a, outcome: "migrate" })) as { proposalId: string; assignments: string };
    assert.equal(d.assignments, "by-coordinator");
    const p = (await w.chat().getProposal(w.ownerToken, d.proposalId))!;
    assert.deepEqual(p.steps.filter((s) => s.op === "task.assign").map((s) => s.as), ["coordinator", "coordinator"]);
    const applied = await w.chat().applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: d.proposalId });
    assert.equal(applied.applied, true);
    const audit = (await w.world.storage.listAudit({ afterSeq: 0, limit: 500 })).filter((e) => e.type === "task.assign");
    assert.deepEqual(audit.map((e) => e.actor), ["agent:coord", "agent:coord"], "made by the coordinator under its own grant");
    // a chat service with no coordinator credential cannot run those steps, and the proposal stays open
    const d2 = (await c.service.decompose(c.owner, { commandId: cid("d"), projectId: a, outcome: "migrate again" })) as { proposalId: string };
    const blind = w.chat({ coordinatorToken: async () => undefined });
    const failed = await blind.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: d2.proposalId });
    assert.deepEqual([failed.applied, failed.failure!.code], [false, "unavailable"]);
    assert.equal((await blind.getProposal(w.ownerToken, d2.proposalId))!.status, "open");
    const resumed = await w.chat().applyProposal(w.ownerToken, { commandId: cid("ap2"), proposalId: d2.proposalId });
    assert.equal(resumed.applied, true, "carries on; the steps already done were not repeated");
    assert.equal((await w.projects.listTasks({ projectId: a, limit: 20 })).items.length, 6);
  });

  suite("a plan the model got wrong is refused whole: a ring, an unknown dependency, an unknown repository, too many tasks; tasks with no repository are not assigned", async (w) => {
    const a = await w.project("A");
    const none = await w.project("None", []);
    const bad: Record<string, unknown> = {
      ring: { tasks: [{ key: "a", title: "A", dependsOn: ["b"] }, { key: "b", title: "B", dependsOn: ["a"] }] },
      unknown: { tasks: [{ key: "a", title: "A", dependsOn: ["zzz"] }] },
      repo: { tasks: [{ key: "a", title: "A", repositoryId: "nope" }] },
      many: { tasks: Array.from({ length: 21 }, (_, i) => ({ key: `t${i}`, title: "T" })) },
      dup: { tasks: [{ key: "a", title: "A" }, { key: "a", title: "B" }] },
      extra: { tasks: [{ key: "a", title: "A", shell: "rm" }] },
      shape: "tasks please",
    };
    let which = "ring";
    const c = await withOwner(w, scripted(() => bad[which] ?? { tasks: [{ key: "a", title: "Solo", assignTo: { kind: "agent", id: "ann" } }] }));
    await start(c);
    for (const key of Object.keys(bad)) { which = key; await assert.rejects(c.service.decompose(c.owner, { commandId: cid("d"), projectId: a, outcome: "go" }), refuses("invalid_command"), key); }
    assert.equal((await w.projects.listTasks({ projectId: a, limit: 10 })).items.length, 0);
    which = "ok";
    const d = (await c.service.decompose(c.owner, { commandId: cid("d"), projectId: none, outcome: "go" })) as unknown as { assignments: string; notes: string[]; proposalId: string };
    assert.equal(d.assignments, "none");
    assert.match(d.notes[0]!, /no repository/);
    await assert.rejects(c.service.decompose(c.owner, { commandId: cid("d"), projectId: "proj-aaaaaaaaaaaaaaaaaaaa", outcome: "go" }), refuses("not_found"));
    await assert.rejects(c.service.decompose(c.owner, { commandId: cid("d"), projectId: a, outcome: "key sk-abcdefghijklmnopqrstuvwxyz123456" }), refuses("invalid_command"));
  });

  suite("only the owner (not a task-scoped owner credential) uses it, and the credential held must be the configured principal", async (w) => {
    const a = await w.project("A");
    const c = await withOwner(w, scripted(() => ({})));
    const running = await start(c);
    const scoped = { ...w.owner, taskScope: { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: a } };
    await assert.rejects(c.service.setState(scoped, { commandId: cid("s"), expectedRevision: running.revision, to: "paused" }), refuses("forbidden"));
    await assert.rejects(c.service.answer(scoped, { commandId: cid("q"), projectId: a, question: "anything" }), refuses("forbidden"));
    await assert.rejects(c.service.decompose(scoped, { commandId: cid("d"), projectId: a, outcome: "go" }), refuses("forbidden"));
    // the owner points the record at another principal: the credential the controller holds is not that one
    await c.service.configure(c.owner, { commandId: cid("cfg"), principalId: "agent:somebody", routes: ["p"], expectedRevision: running.revision });
    assert.deepEqual(await c.service.answer(c.owner, { commandId: cid("q"), projectId: a, question: "anything" }), { kind: "unavailable", reason: "the coordinator's credential is not the configured principal" });
  });

  suite("assignments: with the grant the coordinator makes them itself, with reasons recorded; without it they are a proposal; a task with no repository is skipped; a plan with anything else waits", async (w) => {
    const a = await w.project("A", [{ id: "main", location: "/m" }, { id: "other", location: "/o" }]);
    const withRepo = await w.task(a, "With repo", { repositoryId: "main" });
    const bare = await w.task(a, "Bare");
    const picks = { assignments: [{ taskId: withRepo, owner: { kind: "agent", id: "ann" }, reason: "Ann knows the schema" }, { taskId: bare, owner: { kind: "agent", id: "ben" }, reason: "free this week" }] };
    const model = scripted((r) => (r.kind === "assign" ? picks : {}));
    const c = await withOwner(w, model);
    await start(c);
    // no grant: a proposal, nothing assigned
    const proposed = await c.service.assign(c.owner, { commandId: "as-1", projectId: a });
    assert.equal(proposed.kind, "proposed");
    assert.deepEqual((proposed as { skipped: string[] }).skipped, [`${bare}: no repository`]);
    assert.equal(await w.assignments.getAssignment(withRepo), undefined);
    const saved = (await w.chat().getProposal(w.ownerToken, (proposed as { proposalId: string }).proposalId))!;
    assert.deepEqual(saved.pins, [{ taskId: withRepo, projectId: a, repositoryId: "main" }], "the proposal carries the project and repository it was drawn up with");
    // the repository changes before the owner applies: refused, nothing assigned
    const rev = (await w.api.handle(w.ownerToken, { v: 1, op: "task.get", args: { taskId: withRepo } }) as unknown as { result: { item: { revision: number } } }).result.item.revision;
    await w.projects.updateTask({ commandId: cid("u"), actor: "owner:rob", taskId: withRepo, expectedRevision: rev, repositoryId: "other" } as never);
    await assert.rejects(w.chat().applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: saved.id }), (e: unknown) => e instanceof DomainError && /no longer in the project and repository/.test(e.message));
    assert.equal(await w.assignments.getAssignment(withRepo), undefined);
    const shown = model.requests[0] as Extract<CoordinatorRequest, { kind: "assign" }>;
    assert.deepEqual(shown.tasks.map((x) => x.id).sort(), [withRepo, bare].sort());
    assert.equal(shown.tasks.find((x) => x.id === withRepo)!.repositoryId, "main");
  });

  suite("a coordinator granted assignment makes assignment-only plans without the owner's apply", async (w) => {
    const a = await w.project("A");
    const withRepo = await w.task(a, "With repo", { repositoryId: "main" });
    const bare = await w.task(a, "Bare");
    const picks = { assignments: [{ taskId: withRepo, owner: { kind: "agent", id: "ann" }, reason: "Ann knows the schema" }, { taskId: bare, owner: { kind: "agent", id: "ben" }, reason: "free this week" }] };
    const c = await withOwner(w, scripted((r) => (r.kind === "assign" ? picks : {})), [{ action: "attempt.work", project: "*" }, { action: "assignment.manage", project: a }] as never);
    await start(c);
    const made = await c.service.assign(c.owner, { commandId: "as-2", projectId: a });
    assert.deepEqual(made, { kind: "made", assigned: [{ taskId: withRepo, owner: "agent:ann", reason: "Ann knows the schema" }], skipped: [`${bare}: no repository`] });
    assert.equal((await w.assignments.getAssignment(withRepo))!.owner!.id, "ann");
    assert.equal(await w.assignments.getAssignment(bare), undefined);
    const audit = (await w.world.storage.listAudit({ afterSeq: 0, limit: 500 })).filter((e) => e.type === "task.assign");
    assert.deepEqual(audit.map((e) => e.actor), ["agent:coord"]);
  });
}
