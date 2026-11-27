import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError } from "../domain/errors.js";
import { stopServer } from "../domain/testing/backends.js";
import type { FloorDeps } from "./floor.js";
import type { FloorBody } from "./floor-types.js";
import { floorSuite, type FloorWorld } from "./floor-suite.js";
import { floorFollowUps, floorSourceRevision } from "./floor-wiring.js";

// Card M05, the production side of two floor ports: a source an answer to the owner cites is checked against the meeting's own project only (stale, or "not checked", never taken as current), and what an ended meeting left
// open becomes follow-up tasks given to the agents that own them, made by the floor itself once the meeting has ended.

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const MOTION = "Move the nightly build to 01:00 because the cache is warm then.";
const reply = (text: string) => ({ text, usage: { visibleTokens: 20, hiddenTokens: 0 } });
const bare = (agent: string): string => agent.slice("agent:".length);
const floorOf = async (w: FloorWorld, rec: string): Promise<FloorBody> => (await w.floor.state(w.owner, rec)) as unknown as FloorBody;
const transcript = async (w: FloorWorld, rec: string): Promise<{ speaker: string; text: string }[]> => (await w.records.discussion(w.owner, rec, { limit: 100 }))!.entries as never;
const start = async (w: FloorWorld, rec: string): Promise<string> => (await w.floor.start(w.service, { commandId: cid("st"), recordId: rec, motion: { text: MOTION } })).motionId!;
const run = async (w: FloorWorld, rec: string): Promise<void> => { await w.floor.drive(w.service, { recordId: rec, maxUnits: 200 }); };
const assignmentsOf = (w: FloorWorld): AssignmentService => AssignmentService.withEpoch(w.storage, w.epoch, w.projects);
const production = (w: FloorWorld, assign?: FloorDeps["followUps"]): Partial<FloorDeps> => {
  const a = assignmentsOf(w);
  return { sourceRevision: floorSourceRevision(w.storage), followUps: assign ?? floorFollowUps({ createTask: async (c) => w.projects.createTask(c), assignTask: async (c) => a.assignTask(c), actor: "service:meeting-records" }) };
};
const otherProjectTask = async (w: FloorWorld): Promise<{ project: string; task: string }> => {
  const project = (await w.projects.createProject({ commandId: cid("pb"), actor: w.owner.id, name: "B" })).id;
  const task = (await w.projects.createTask({ commandId: cid("tb"), actor: w.owner.id, projectId: project, title: "Elsewhere" })).id;
  return { project, task };
};
const retitle = async (w: FloorWorld, id: string, title: string): Promise<void> => {
  await w.projects.updateTask({ commandId: cid("ut"), actor: w.owner.id, taskId: id, expectedRevision: (await w.projects.getTask(id))!.revision, title });
};
const setProject = async (w: FloorWorld, state: "archived" | "active"): Promise<void> => {
  await w.projects.updateProject({ commandId: cid("ps"), actor: w.owner.id, projectId: w.project, expectedRevision: (await w.projects.getProject(w.project))!.revision, state } as never);
};
/** A meeting whose owner question leaves an investigation open (owned by agent B), driven to its decision. */
const meetingWithInvestigation = async (w: FloorWorld): Promise<string> => {
  const { rec } = await w.meet();
  await start(w, rec);
  w.script.on((r) => (r.kind === "owner-answer" ? reply("ANSWER: Needs a week of measuring.\nSOURCES: none\nCOMPLETED: none\nPROPOSED: none\nINVESTIGATE: measure the cache hit rate over a week") : undefined));
  await w.floor.ask(w.owner, { commandId: cid("ask"), recordId: rec, agent: w.pB, question: "What is the real hit rate?" });
  await run(w, rec);
  return rec;
};
/** Deletes a record the way retention does (the storage keeps a tombstone of another kind). */
const removeAggregate = async (w: FloorWorld, kind: string, id: string): Promise<void> => {
  const found = (await w.storage.getAggregate({ kind, id }))!;
  const ref = { kind, id };
  await w.storage.applyOperation({ operationId: cid("del"), epoch: await w.storage.currentEpoch(), actor: "service:test", correlationId: cid("del"), at: "2026-11-14T08:00:00.000Z", changes: [{ type: "delete", ref, expectedRevision: found.revision }], audit: [{ type: "test.delete", subject: ref, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
};
const tasksTitled = async (w: FloorWorld, prefix: string): Promise<string[]> => (await w.projects.listTasks({ projectId: w.project, limit: 200 })).items.filter((t) => t.title.startsWith(prefix)).map((t) => t.id);

floorSuite(test, "a cited source's revision is read only for a project-visible record of the meeting's own project; anything else is not checked", async (w) => {
  const src = floorSourceRevision(w.storage);
  const ctx = { projectId: w.project, agent: w.pA };
  const t = await w.task("Cache warmer");
  assert.equal(await src({ kind: "task", id: t.id }, ctx), t.revision);
  await retitle(w, t.id, "Cache warmer, nightly");
  assert.equal(await src({ kind: "task", id: t.id }, ctx), t.revision + 1, "the current revision, after a change");
  assert.equal(await src({ kind: "project", id: w.project }, ctx), (await w.projects.getProject(w.project))!.revision, "the meeting's own project");
  const other = await otherProjectTask(w);
  assert.equal(await src({ kind: "task", id: other.task }, ctx), undefined, "another project's task is not checked");
  assert.equal(await src({ kind: "project", id: other.project }, ctx), undefined, "another project is not checked");
  assert.ok((await w.storage.getAggregate({ kind: "agent", id: bare(w.pA) })) !== undefined, "the agent record exists");
  assert.equal(await src({ kind: "agent", id: bare(w.pA) }, ctx), undefined, "a private kind is not checked, even when the record exists");
  assert.equal(await src({ kind: "desk-record", id: "dsk-anything" }, ctx), undefined, "a desk is never checked");
  // a private record of the meeting's own project: only its kind keeps it from being told
  const desk = (await w.desks.write(w.asA, { commandId: cid("dw"), projectId: w.project, kind: "note", title: "draft", body: "A's draft", visibility: "private", status: "draft" } as never)) as unknown as { id: string };
  const stored = await w.storage.getAggregate({ kind: "desk-record", id: desk.id });
  assert.equal((stored?.body as { projectId?: unknown } | undefined)?.projectId, w.project, "the desk record is in the meeting's project");
  assert.equal(await src({ kind: "desk-record", id: desk.id }, ctx), undefined, "a desk record of the meeting's own project is not checked");
  assert.equal(await src({ kind: "task", id: "tsk-does-not-exist" }, ctx), undefined, "a missing record is not checked");
  const gone = await w.task("Removed later");
  await removeAggregate(w, "task", gone.id);
  assert.equal(await w.storage.getAggregate({ kind: "task", id: gone.id }), undefined, "the task is deleted");
  assert.equal(await src({ kind: "task", id: gone.id }, ctx), undefined, "a deleted record of the meeting's own project is not checked");
  let reads = 0;
  const counted = floorSourceRevision({ getAggregate: async (ref) => { reads += 1; return w.storage.getAggregate(ref); } });
  for (const bad of [{ kind: "task", id: "../etc/passwd" }, { kind: "task", id: "x".repeat(500) }, { kind: "task", id: "x".repeat(121) }, { kind: "task", id: "tsk-été" }, { kind: "task", id: "" }, { kind: "Task", id: t.id }, { kind: "", id: t.id }, { kind: 7, id: t.id }, { kind: "task", id: null }]) {
    assert.equal(await src(bad as never, ctx), undefined, `hostile cite refused: ${JSON.stringify(bad).slice(0, 60)}`);
    assert.equal(await counted(bad as never, ctx), undefined);
  }
  assert.equal(reads, 0, "a malformed or oversized cite is refused before any read");
  assert.equal(await counted({ kind: "task", id: "x".repeat(120) }, ctx), undefined);
  assert.equal(reads, 1, "an ID of 120 characters is still looked up");
  const failing = floorSourceRevision({ getAggregate: async () => { throw new Error("read failed at /var/lib/secret"); } });
  assert.equal(await failing({ kind: "task", id: t.id }, ctx), undefined, "a failed read is not checked, and the error is not passed on");
});

floorSuite(test, "the production follow-up maker gives an agent-owned task to that agent once, and leaves any other task unassigned", async (w) => {
  const a = assignmentsOf(w);
  const make = floorFollowUps({ createTask: async (c) => w.projects.createTask(c), assignTask: async (c) => a.assignTask(c), actor: "service:meeting-records" });
  const one = await make.create({ commandId: cid("fu"), projectId: w.project, title: "Investigate: the hit rate", description: "Deeper work.", owner: w.pB });
  assert.equal(one.assigned, true);
  const as = await a.getAssignment(one.id);
  assert.deepEqual([as?.state, as?.owner], ["assigned", { kind: "agent", id: bare(w.pB) }], "assigned to the agent by its bare ID");
  assert.match((await w.projects.getTask(one.id))!.description, /Owner: agent:/, "the description still names the owner");
  const again = await make.create({ commandId: `fu-${n - 1}`, projectId: w.project, title: "Investigate: the hit rate", description: "Deeper work.", owner: w.pB });
  assert.deepEqual([again.id, again.assigned], [one.id, true], "a repeat makes no second task");
  assert.equal((await a.history(one.id)).length, 1, "and no second assignment");
  const owners: (string | undefined)[] = [undefined, "owner", "agent:../x", "agent:", `${w.pB} `];
  for (const owner of owners) {
    const t = await make.create({ commandId: cid("fu"), projectId: w.project, title: "Answer: who owns it", description: "Left open.", ...(owner === undefined ? {} : { owner }) });
    assert.equal(t.assigned, undefined, `no assignment tried for ${String(owner)}`);
    assert.equal(await a.getAssignment(t.id), undefined);
  }
  const refused = floorFollowUps({ createTask: async (c) => w.projects.createTask(c), assignTask: async () => { throw new DomainError("invalid_command", "agent is retired"); }, actor: "service:meeting-records" });
  const kept = await refused.create({ commandId: cid("fu"), projectId: w.project, title: "Find out: the warmer", description: "Never answered.", owner: w.pC });
  assert.equal(kept.assigned, false, "an assignment that cannot be made is reported");
  assert.ok((await w.projects.getTask(kept.id)) !== undefined, "and the task stays");
});

floorSuite(test, "an answer to the owner marks a changed source stale and lists sources it could not check, telling nothing of another project's record", async (w) => {
  w.reopen(production(w));
  const changed = await w.task("Cache warmer");
  await retitle(w, changed.id, "Cache warmer v2");
  const same = await w.task("Build host");
  const other = await otherProjectTask(w);
  for (let i = 0; i < 3; i += 1) await w.projects.updateTask({ commandId: cid("uo"), actor: w.owner.id, taskId: other.task, expectedRevision: i + 1, title: `Elsewhere ${i}` });
  const desk = (await w.desks.write(w.asA, { commandId: cid("dw"), projectId: w.project, kind: "note", title: "draft", body: "A's draft", visibility: "private", status: "draft" } as never)) as unknown as { id: string };
  const gone = await w.task("Removed later");
  await removeAggregate(w, "task", gone.id);
  const { rec } = await w.meet();
  await start(w, rec);
  const hidden = [`agent:${bare(w.pA)}@1`, `task:${other.task}@1`, "task:tsk-missing@1", `desk-record:${desk.id}@1`, `task:${gone.id}@1`];
  const sources = [`task:${changed.id}@1`, `task:${same.id}@1`, ...hidden.slice(0, 3), `task:${changed.id}`, ...hidden.slice(3)];
  w.script.on((r) => (r.kind === "owner-answer" ? reply(`ANSWER: The warmer runs at midnight.\nSOURCES: ${sources.join(", ")}\nCOMPLETED: checked the schedule\nPROPOSED: move it to 01:00\nINVESTIGATE: none`) : undefined));
  await w.floor.ask(w.owner, { commandId: cid("ask"), recordId: rec, agent: w.pB, question: "When does the warmer run?" });
  await run(w, rec);
  const answer = (await floorOf(w, rec)).ownerAnswers.at(-1)!;
  assert.deepEqual(answer.stale, [`task:${changed.id}@1 (now at revision 2)`]);
  // the same words for every source that was not checked, whatever the reason: a private kind, another project's record, a missing one, a desk record of this project, a deleted one
  assert.deepEqual(answer.unchecked, hidden, "private, another project's, missing, desk and deleted sources are not checked, each listed as cited");
  assert.deepEqual([answer.completed, answer.proposed], [["checked the schedule"], ["move it to 01:00"]], "done and proposed stay apart");
  const said = (await transcript(w, rec)).find((e) => e.text.startsWith("(to the owner)"))!.text;
  assert.match(said, /Stale sources \(changed since the agent looked\): task:\S+@1 \(now at revision 2\)/);
  assert.ok(said.split("\n").includes(`Sources not checked (could not be confirmed current): ${hidden.join("; ")}`), said);
  assert.ok(!said.includes("revision 4"), "another project's revision is never told");
  assert.ok(!said.includes(`${same.id}@1 (now`), "a current source is not marked");
});

floorSuite(test, "at most ten cited revisions are looked up for one answer; the rest are counted as not checked", async (w) => {
  let reads = 0;
  const real = floorSourceRevision(w.storage);
  w.reopen({ ...production(w), sourceRevision: async (c, x) => { reads += 1; return real(c, x); } });
  const t = await w.task("Cache warmer");
  const { rec } = await w.meet();
  await start(w, rec);
  const many = Array.from({ length: 15 }, () => `task:${t.id}@1`).join(", ");
  w.script.on((r) => (r.kind === "owner-answer" ? reply(`ANSWER: See the task.\nSOURCES: ${many}\nCOMPLETED: none\nPROPOSED: none\nINVESTIGATE: none`) : undefined));
  await w.floor.ask(w.owner, { commandId: cid("ask"), recordId: rec, agent: w.pA, question: "Where is it written?" });
  // drive takes the command ID the API passes and still refuses a field it does not know, itself (not only through the API's argument list)
  await assert.rejects(w.floor.drive(w.service, { recordId: rec, maxUnits: 1, commandId: cid("dr"), extra: true } as never), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
  await w.floor.drive(w.service, { recordId: rec, maxUnits: 200, commandId: cid("dr") });
  assert.equal(reads, 10, "ten reads");
  assert.deepEqual((await floorOf(w, rec)).ownerAnswers.at(-1)!.unchecked, ["5 more"]);
});

floorSuite(test, "when the owner ends the meeting, what it left open becomes follow-up tasks given to their owners, once, also after a restart", async (w) => {
  w.reopen(production(w));
  const rec = await meetingWithInvestigation(w);
  assert.equal((await tasksTitled(w, "Investigate:")).length, 0, "nothing is made before the end");
  await w.floor.end(w.owner, { commandId: cid("end"), recordId: rec });
  const f = await floorOf(w, rec);
  assert.ok(f.followUpsAt !== undefined, "the floor noted that it made them");
  const inv = f.followUps.find((x) => x.title.startsWith("Investigate: measure the cache hit rate"))!;
  assert.deepEqual([inv.owner, inv.assigned], [w.pB, true]);
  assert.deepEqual((await assignmentsOf(w).getAssignment(inv.taskId))?.owner, { kind: "agent", id: bare(w.pB) }, "the task is the agent's");
  for (const x of f.followUps) if (x.owner?.startsWith("agent:") === true) assert.equal(x.assigned, true, `${x.title} is assigned`);
  w.reopen(production(w));
  await w.floor.tick(w.service);
  await w.floor.tick(w.service);
  assert.equal((await w.floor.followUps(w.service, { recordId: rec })).created.length, 0, "asking again makes nothing");
  assert.equal((await tasksTitled(w, "Investigate:")).length, 1, "one task, after a restart and later turns");
});

floorSuite(test, "a meeting whose record was finished by other means gets its follow-ups from the scheduled turn", async (w) => {
  w.reopen(production(w));
  const rec = await meetingWithInvestigation(w);
  await w.records.finish(w.service, { commandId: cid("fin"), recordId: rec });
  await w.floor.tick(w.service);
  await w.floor.tick(w.service);
  const f = await floorOf(w, rec);
  assert.equal(f.state, "ended");
  assert.ok(f.followUpsAt !== undefined);
  assert.equal((await tasksTitled(w, "Investigate:")).length, 1);
});

floorSuite(test, "follow-ups that cannot be made are tried a bounded number of times, then the owner is told once, in words that carry no error text", async (w) => {
  let calls = 0;
  w.reopen(production(w, { create: async () => { calls += 1; throw new DomainError("unavailable", "store at /var/lib/nn-secret is down"); } }));
  const rec = await meetingWithInvestigation(w);
  await w.floor.end(w.owner, { commandId: cid("end"), recordId: rec });
  assert.equal(calls, 1, "the end tried once and still ended");
  assert.equal((await floorOf(w, rec)).state, "ended");
  for (let i = 0; i < 6; i += 1) await w.floor.tick(w.service);
  assert.equal(calls, 3, "three tries in all");
  const f = await floorOf(w, rec);
  assert.deepEqual([f.followUpTries, f.followUpsAt], [3, undefined]);
  const told = w.notices.filter((x) => x.kind === "follow-ups-failed");
  assert.equal(told.length, 1, "told once");
  assert.ok(!told[0]!.text.includes("nn-secret") && told[0]!.text.includes("unavailable"), told[0]!.text);
});

floorSuite(test, "an archived project's ended meeting makes no follow-ups and spends no tries until the project is restored", async (w) => {
  let calls = 0;
  const real = production(w).followUps!;
  w.reopen(production(w, { create: async (i) => { calls += 1; return real.create(i); } }));
  const rec = await meetingWithInvestigation(w);
  await setProject(w, "archived");
  await w.floor.end(w.owner, { commandId: cid("end"), recordId: rec });
  await w.floor.tick(w.service);
  await w.floor.tick(w.service);
  assert.equal(calls, 0, "nothing made while archived");
  assert.equal((await floorOf(w, rec)).followUpTries, undefined, "no tries spent");
  await setProject(w, "active");
  await w.floor.tick(w.service);
  assert.ok(calls >= 1 && (await floorOf(w, rec)).followUpsAt !== undefined, "made once the project is back");
});
