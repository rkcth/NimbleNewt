import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { EXEC_PROFILES, PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import type { WorkerTurnResult } from "../dispatch/ports.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import { NotificationService } from "../notifications/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { startController, type Controller } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const TABLE = {
  providers: { localp: { enabled: true, paid: false, location: "local" }, localq: { enabled: true, paid: false, location: "local" } },
  routes: { "localp/small": { contextTokens: 128_000, capabilities: ["tools"] }, "localp/other": { contextTokens: 128_000, capabilities: ["tools"] }, "localq/judge": { contextTokens: 128_000, capabilities: ["tools"] }, "localq/backup": { contextTokens: 128_000, capabilities: ["tools"] } },
  profiles: { "r-local": ["localp/small", "localq/backup"], judge: ["localq/judge", "localp/other"] }, roles: { coordinator: "r-local", "safety-supervisor": "judge" },
};
const HOUR = 3_600_000, DAY = 24 * HOUR;

/**
 * Card M03h: one scheduled stand-up, driven by the running controller's own loops (real `startController`, a temporary SQLite data directory, a scripted worker standing in for the model, no network), and every sink it feeds
 * is asked, once, whether it saw it exactly once: the stand-up's records, the advance notice to each agent, the owner's question and its notification, the usage sink (worker-slot time) in the preparation review, the activity record
 * and its replay for a task the meeting changed, and the retention rule over the stand-up's derived records.
 */
test("a scheduled stand-up runs through the running controller and every sink sees it exactly once (card M03h)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-su-e2e-"));
  let skew = -30 * DAY;
  const clock = (): string => new Date(Date.now() + skew).toISOString();
  const worker = new ScriptedWorker("host:w1", async (): Promise<WorkerTurnResult> => { skew += 20 * 60_000; return { status: "completed", text: "Watered the beds.", checkpoint: { turn: 1 } }; });
  const c: Controller = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, workers: [worker], clock },
    chat: { interpreter: new ScriptedInterpreter({}) },
  } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const ok = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => { const r = await call(token, op, args, commandId); assert.ok(r.ok, `${op}: ${JSON.stringify(r)}`); return r.result; };
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: TABLE } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
    await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
    await hosts.heartbeat(hostP, { commandId: "hb1", sequence: 1 });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;

    // Two agents on the roster. Ann works a task (and may change tasks), Bob only attends.
    const annId = (await s.agents.create(owner, { commandId: "ag-ann", friendlyName: "Ann" })).id;
    const bobId = (await s.agents.create(owner, { commandId: "ag-bob", friendlyName: "Bob" })).id;
    for (const g of [...workGrants(project), { action: "task.update", project }, { action: "meeting.attend", project }]) await s.grants.grant(owner, { commandId: `g-ann-${g.action}`, grantee: `agent:${annId}`, action: g.action, project, source: "direct", basis: "test" });
    await s.grants.grant(owner, { commandId: "g-bob-1", grantee: `agent:${bobId}`, action: "meeting.attend", project, source: "direct", basis: "test" });
    await s.grants.grant(owner, { commandId: "g-bob-2", grantee: `agent:${bobId}`, action: "task.read", project, source: "direct", basis: "test" });
    const annToken = (await s.principals.issueCredential(owner, `agent:${annId}`)).token;
    const bobToken = (await s.principals.issueCredential(owner, `agent:${bobId}`)).token;

    // The stand-up: daily at 09:00 UTC, set up through the state API (a day ahead, so the controller's own tick plants it at its slot). Everything below happens thirty days in the past of the real clock, so that the retention
    // rule (which reads the real clock) finds the stand-up's derived records old.
    const tomorrow = new Date(Date.now() + skew + DAY).toISOString().slice(0, 10);
    const made = await ok(boot.token, "standup.configure", { projectId: project, title: "Morning", roster: [`agent:${annId}`, `agent:${bobId}`], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "UTC", recurrence: { kind: "daily" }, startDate: tomorrow, prepareMinutes: 60, coverageHours: 72 }, "su1");
    const scheduleId = made.scheduleId as string;

    // The work the stand-up reports on: a task Ann works through the dispatcher and the scripted worker (twenty minutes of a worker slot), and a task the meeting will change.
    const task = async (key: string, title: string): Promise<string> => {
      const id = (await s.projects.createTask({ commandId: `t-${key}`, actor: owner.id, projectId: project, title })).id;
      await s.projects.transitionTask({ commandId: `r-${key}`, actor: owner.id, taskId: id, expectedRevision: 1, to: "ready" });
      return id;
    };
    const waterTask = await task("w", "Water the beds");
    await s.assignments.assignTask({ commandId: "as-w", actor: owner.id, taskId: waterTask, owner: { kind: "agent", id: annId } });
    const a1 = (await s.assignments.getAssignment(waterTask))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "ad-w", actor: "inbox", taskId: waterTask, expectedRevision: a1.revision, generation: a1.generation, owner: { kind: "agent", id: annId }, harness: "pi" })).id;
    for (let i = 0; i < 5 && (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))?.state !== "finished"; i++) { await c.dispatch!.dispatcher.tick(); await c.dispatch!.dispatcher.idle(); }
    const ran = (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))!;
    assert.equal(ran.state, "finished", JSON.stringify(ran));
    assert.equal(ran.slotSpans?.length, 1);
    const coverTask = await task("c", "Cover the beds");
    // Ann has a second, unfinished task so the notice has a task to be filed against; Bob holds none.
    const kinds = async (kind: string): Promise<{ id: string; revision: number; body: any }[]> => { const out: { id: string; revision: number; body: any }[] = []; for (let after: string | undefined; ;) { const page = await c.storage.listAggregates(kind, { limit: 200, ...(after === undefined ? {} : { afterId: after }) } as never); for (const a of page) out.push({ id: a.id, revision: a.revision, body: a.body }); if (page.length < 200) break; after = page[page.length - 1]!.id; } return out; };

    // Before the slot nothing is held. At half past eight the controller's own tick plants the occurrence and prepares it.
    await c.dispatch!.dispatcher.tick();
    assert.equal((await ok(boot.token, "meeting.schedule-get", { scheduleId })).item.occurrences, 0);
    skew = Date.parse(`${tomorrow}T08:30:00.000Z`) - Date.now();
    for (let i = 0; i < 3; i++) { const t = await c.dispatch!.dispatcher.tick(); await c.dispatch!.dispatcher.idle(); assert.ok(t.loops.every((l) => l.ok), JSON.stringify(t.loops.filter((l) => !l.ok))); }
    const sched = (await ok(boot.token, "meeting.schedule-get", { scheduleId })).item;
    assert.equal(sched.occurrences, 1, JSON.stringify(sched));
    const occ = sched.lastOccurrenceId as string;
    const prepared = (await ok(boot.token, "standup.prepared", { occurrenceId: occ })).item;

    // SINK 1, the stand-up's records: one occurrence for the slot, one preparation record, one brief per agent on the roster, however often the tick ran.
    const prepRevision = prepared.revision as number;
    assert.equal((await kinds("meeting-occurrence")).filter((o) => o.body.scheduleId === scheduleId).length, 1);
    assert.deepEqual((await kinds("standup-prep")).map((x) => x.id), [occ]);
    const briefs = (await kinds("standup-brief")).filter((b) => b.body.occurrenceId === occ);
    assert.deepEqual(briefs.map((b) => b.body.agent).sort(), [`agent:${annId}`, `agent:${bobId}`].sort());
    assert.deepEqual(Object.keys(prepared.briefs).sort(), briefs.map((b) => b.body.agent).sort());

    // SINK 2a, the advance notice: Ann (who holds a task) is told once, on that task; nothing is filed for Bob (none), and he is not recorded as told (he is asked about again should he take a task before the meeting).
    const noticesNow = async () => (await kinds("agent-message")).filter((m) => m.body.purpose === "A stand-up is coming");
    assert.equal((await noticesNow()).length, 1);
    assert.equal((await noticesNow())[0]!.body.to, `agent:${annId}`);
    assert.equal((await noticesNow())[0]!.body.taskId, waterTask);
    assert.match((await noticesNow())[0]!.body.text, /Stand-up at 20\d\d-\d\d-\d\dT09:00:00\.000Z\. Reach a safe boundary/);
    assert.deepEqual(Object.keys(prepared.notified), [`agent:${annId}`]);

    // SINK 3, the usage sink: the review counts the worker-slot time of the attempt the dispatcher recorded (one attempt, not a count of tasks).
    const reviewText = (prepared.review.lines as { text: string }[]).map((l) => l.text).join("\n");
    assert.match(reviewText, /actual PC share 0% \(worker-slot time of 1 attempt\)/);
    assert.doesNotMatch(reviewText, /not measured here/);

    // More ticks change none of it.
    for (let i = 0; i < 2; i++) { await c.dispatch!.dispatcher.tick(); await c.dispatch!.dispatcher.idle(); }
    assert.equal((await ok(boot.token, "standup.prepared", { occurrenceId: occ })).item.revision, prepRevision, "a repeated preparation writes nothing");
    assert.equal((await noticesNow()).length, 1);
    assert.equal((await kinds("standup-brief")).filter((b) => b.body.occurrenceId === occ).length, 2);

    // The stand-up is held at nine: the owner chairs a meeting record, Ann moves a change to a task, both vote.
    skew = Date.parse(`${tomorrow}T09:05:00.000Z`) - Date.now();
    await c.dispatch!.dispatcher.tick(); await c.dispatch!.dispatcher.idle();
    const rec = (await ok(boot.token, "meeting.record.open", { occurrenceId: occ, chair: `agent:${annId}` }, "mo1")).id as string;
    for (const [t, id] of [[annToken, "j1"], [bobToken, "j2"]] as const) await ok(t, "meeting.record.join", { recordId: rec }, id);
    const cover = (await ok(boot.token, "task.get", { taskId: coverTask })).item;
    const moved = await ok(annToken, "meeting.record.move", { recordId: rec, text: "Retitle the cover task to say it is for tonight.", topic: "beds", changes: [{ kind: "task.update", agent: `agent:${annId}`, target: { kind: "task", id: coverTask }, expectedRevision: cover.revision, patch: { title: "Cover the beds tonight" }, summary: "retitle the task" }] }, "mv1");
    await ok(boot.token, "meeting.record.open-vote", { motionId: moved.id, expectedVersion: 1 }, "ov1");
    for (const [t, id] of [[annToken, "b1"], [bobToken, "b2"]] as const) await ok(t, "meeting.record.cast-ballot", { motionId: moved.id, version: 1, value: "yes", reason: "agreed" }, id);
    const closed = await ok(boot.token, "meeting.record.close-vote", { motionId: moved.id }, "cv1");
    assert.equal(closed.state, "adopted", JSON.stringify(closed));
    assert.equal((await ok(boot.token, "meeting.record.apply", { decisionId: closed.decisionId }, "ap1")).applied, 1);
    await ok(boot.token, "meeting.record.apply", { decisionId: closed.decisionId }, "ap2");
    assert.equal((await ok(boot.token, "task.get", { taskId: coverTask })).item.title, "Cover the beds tonight");

    // The meeting ends with a summary (a derived record of its own). The record service reads the real clock, which is thirty days on, so the record is finished before the controller ticks again.
    await ok(boot.token, "meeting.record.finish", { recordId: rec }, "f1");
    await ok(boot.token, "meeting.record.summarize", { recordId: rec }, "s1");

    // SINK 4, activity and replay: the changed task has exactly one step for the decision, and the replay the owner reads shows it once.
    const steps = (await ok(boot.token, "activity.steps", { taskId: coverTask })).steps as { kind: string; summary: string }[];
    assert.equal(steps.filter((x) => x.kind === "meeting-decision").length, 1, JSON.stringify(steps));
    const replay = await ok(boot.token, "status.ask", { request: { kind: "replay", taskId: coverTask } });
    const replayed = (replay.item.lines as { text: string }[]).filter((l) => /meeting decision changed this task/i.test(l.text));
    assert.equal(replayed.length, 1, JSON.stringify(replay.item.lines));

    // SINK 2b, the owner's question: the stand-up settles a topic and asks; the controller's own ticks announce it once in the owner's inbox.
    const topic = await ok(boot.token, "agenda.capture", { projectId: project, topic: "Replace the hose?", question: "Should we replace the hose?", urgency: "normal", intent: "discussion" }, "ag1");
    await ok(boot.token, "agenda.settle", { itemId: topic.id, expectedRevision: topic.revision, to: "resolved", outcomeNote: "Yes, after the frost.", ownerQuestion: "Which week should the new hose be bought in?" }, "set1");
    for (let i = 0; i < 3; i++) { await c.dispatch!.dispatcher.tick(); await c.dispatch!.dispatcher.idle(); }
    const inboxQuestions = async () => (await NotificationService.withEpoch(c.storage, c.epoch).inbox(owner)).items.filter((x) => x.ref.kind === "owner-question");
    assert.equal((await inboxQuestions()).length, 1, "announced once by the loop, however often it ran");
    const open = (await ok(boot.token, "standup.owner-questions", { projectId: project })).item.open as { id: string; revision: number; toldAt?: string }[];
    assert.equal(open.length, 1);
    assert.ok(open[0]!.toldAt !== undefined);
    const nextAgenda = (await ok(boot.token, "standup.agenda", { occurrenceId: occ })).item;
    assert.equal(nextAgenda.ownerQuestions.open.length, 1);
    await ok(boot.token, "standup.answer-question", { questionId: open[0]!.id, expectedRevision: open[0]!.revision, answer: "The week of the 20th." }, "aq1");
    assert.equal((await inboxQuestions()).length, 0, "answering closes the notification");
    for (let i = 0; i < 2; i++) { await c.dispatch!.dispatcher.tick(); await c.dispatch!.dispatcher.idle(); }
    assert.equal((await inboxQuestions()).length, 0, "and the loop does not announce it again");
    assert.equal((await kinds("owner-question")).length, 1);

    // SINK 5, retention: the stand-up's briefs are derived records. With the owner's rule set (seven days) and the stand-up thirty days old, one preview lists each brief once and no other record of the stand-up; the run that
    // follows removes exactly those, once, and leaves the preparation record, the meeting's decision and the owner's question on record.
    await ok(boot.token, "retention.settings.set", { derivedDays: 7 }, "rs1");
    const briefIds = briefs.map((b) => b.id).sort();
    const preview = await ok(boot.token, "retention.run", {}, "rr0");
    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.candidates.filter((x: { kind: string }) => x.kind === "standup-brief").map((x: { id: string }) => x.id).sort(), briefIds);
    assert.equal(preview.candidates.filter((x: { kind: string }) => x.kind === "standup-brief").length, 2);
    assert.equal((await ok(boot.token, "retention.check", { kind: "standup-brief", id: briefIds[0]! })).retained, false);
    const ran2 = await ok(boot.token, "retention.run", { dryRun: false, confirm: preview.digest }, "rr1");
    assert.equal(ran2.removed, preview.candidates.length);
    for (const id of briefIds) assert.equal(await c.storage.getAggregate({ kind: "standup-brief", id }), undefined, "a removed brief is gone");
    assert.equal((await kinds("retention-run")).length, 1, "the run is recorded once");
    assert.deepEqual((await ok(boot.token, "retention.run", {}, "rr2")).candidates, [], "nothing is left for a second pass");
    assert.deepEqual((await kinds("standup-prep")).map((x) => x.id), [occ]);
    assert.equal((await ok(boot.token, "standup.briefs", { occurrenceId: occ })).item.length, 0);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
