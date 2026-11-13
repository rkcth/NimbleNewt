import assert from "node:assert/strict";
import { test } from "node:test";
import { rig, sandbox } from "./w03-rig-support.js";
import { workGrants } from "@nimblenewt/controller/testing";

// Card M04h, against the real local worker host: the owner wakes a stopped agent for one meeting, the controller brings it into the room and its meeting attempt RUNS on the real local worker (bubblewrap, the worker
// process running Pi, a scripted model, no network). The agent does its meeting work (a note on its meeting task through the tool bridge) and speaks in the meeting record with its own credential. The meeting ends: the
// dispatcher's graceful stop reaches the real worker, the worker answers the checkpoint, the attempt's stop FINISHES (not merely frozen), and the agent is back stopped as it was.
const until = async (what: string, ok: () => Promise<boolean>, step: () => Promise<void>): Promise<void> => {
  const end = Date.now() + 60_000;
  for (;;) {
    if (await ok()) return;
    if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`);
    await step();
    await new Promise((r) => setTimeout(r, 25));
  }
};

test("a stopped agent woken by the owner attends one meeting on the real local worker host, its attempt's stop finishes with the meeting, and it is back stopped as it was (card M04h)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  const gate = (() => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; })();
  const x = await rig(launcher, [
    { call: { name: "nimblenewt__work-note", args: { kind: "did", text: "joined the meeting and read the agenda" } } },
    // The agent is still working in the room when the meeting ends: this call is held open and is cut by the stop.
    { hold: gate.promise, text: "never sent: the stop arrived first" },
  ], { bare: true });
  try {
    const { c, owner, project, ownerToken } = x;
    const s = c.services;
    const catId = (await s.agents.create(owner, { commandId: "ag-cat", friendlyName: "cat" })).id;
    const cat = `agent:${catId}`;
    for (const g of workGrants(project)) await s.grants.grant(owner, { commandId: `w-${g.action}`, grantee: cat, action: g.action, project, source: "direct", basis: "test" } as never);
    await s.grants.grant(owner, { commandId: "g-read", grantee: cat, action: "task.read", project, source: "direct", basis: "test" });
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { message: string } }>;
    const ok = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => { const r = await call(token, op, args, commandId); assert.ok(r.ok, `${op}: ${JSON.stringify(r)}`); return r.result; };
    await s.grants.grant(owner, { commandId: "g-hist", grantee: cat, action: "history.read", project, source: "direct", basis: "test" });
    const catToken = (await s.principals.issueCredential(owner, cat)).token;
    // A second roster member, stopped the same way and NOT woken: the control that shows the agent's part in the meeting comes from the wake.
    const dogId = (await s.agents.create(owner, { commandId: "ag-dog", friendlyName: "dog" })).id;
    const dog = `agent:${dogId}`;
    for (const g of workGrants(project)) await s.grants.grant(owner, { commandId: `wd-${g.action}`, grantee: dog, action: g.action, project, source: "direct", basis: "test" } as never);
    await s.grants.grant(owner, { commandId: "gd-hist", grantee: dog, action: "history.read", project, source: "direct", basis: "test" });
    const dogToken = (await s.principals.issueCredential(owner, dog)).token;
    // The agent's other work: held by the stop, never started.
    const other = await s.projects.createTask({ commandId: "t-other", actor: owner.id, projectId: project, title: "Weed the beds", description: "work" });
    await s.projects.transitionTask({ commandId: "r-other", actor: owner.id, taskId: other.id, expectedRevision: other.revision, to: "ready" });
    await s.assignments.assignTask({ commandId: "a-other", actor: owner.id, taskId: other.id, owner: { kind: "agent", id: catId }, reason: "work" });

    assert.ok((await call(ownerToken, "lifecycle.stop", { scope: { kind: "agent", id: catId }, mode: "stop", reason: "night" }, "st1")).ok);
    // Everything the agent has before the wake, to compare with after.
    const grantsOf = async () => JSON.stringify((await ok(ownerToken, "grant.list", { grantee: cat })));
    const stopOf = async () => JSON.stringify((await ok(ownerToken, "lifecycle.status", { scope: { kind: "agent", id: catId } })));
    const grantsBefore = await grantsOf();
    const lifecycleBefore = await stopOf();
    assert.equal(await s.pauses.availability(cat), "stopped");
    assert.equal(await s.pauses.isPaused(other.id), true);
    assert.ok((await call(ownerToken, "lifecycle.stop", { scope: { kind: "agent", id: dogId }, mode: "stop", reason: "night" }, "st2")).ok);

    const called = await ok(ownerToken, "meeting.call-urgent", { projectId: project, title: "Frost", reason: "frost tonight", roster: [cat, dog] }, "cu1");
    const occurrenceId = called.id as string;
    await ok(ownerToken, "meeting.attend.open-room", { occurrenceId }, "or1");
    await ok(ownerToken, "meeting.attend.wake", { occurrenceId, agent: cat }, "wk1");

    const wakes = async () => (await ok(ownerToken, "meeting.attend.wakes", {})) .item as any[];
    // Passes of the dispatcher: the wake loop brings the agent in, and the dispatcher starts the meeting attempt on the REAL local worker.
    const tick = async () => { await c.dispatch!.dispatcher.tick(); };
    await until("the woken agent attends", async () => (await wakes())[0]?.state === "attending", tick);
    const wake = (await wakes())[0];
    const taskId = wake.meetingTaskId as string;
    assert.equal(await s.pauses.isPaused(taskId), false, "the bounded meeting task may run past the stop");
    assert.equal(await s.pauses.isPaused(other.id), true, "the agent's other work stays held");

    const attemptOf = async () => { const a = await s.assignments.getAssignment(taskId); return a?.activeAttemptId === undefined ? undefined : await c.dispatch!.dispatcher.get(c.dispatch!.principal, a.activeAttemptId); };
    // The attempt runs on the real worker: it reads the task, makes its note through the bridge and is then in its second model call.
    await until("the attempt works in the meeting", async () => x.answer.seen.length >= 2, tick);
    const running = (await attemptOf())!;
    const attemptId = running.attemptId;
    assert.equal(running.state, "running", JSON.stringify(running));
    assert.equal(running.hostId, "host:w1");
    assert.match(x.answer.seen[0]!, /bounded meeting task of/, "the model was given the meeting task");
    assert.match(x.answer.seen[1]!, /joined the meeting and read the agenda|work-note/, "the agent's note went through the real tool bridge");

    // It speaks in the meeting record with its own credential: it is available, present and the record accepts its turn.
    const rec = (await ok(ownerToken, "meeting.record.open", { occurrenceId }, "mo1")).id as string;
    await ok(catToken, "meeting.record.join", { recordId: rec }, "mj1");
    const turn = await ok(catToken, "meeting.record.append", { recordId: rec, kind: "statement", text: "Cover the tomatoes tonight." }, "ma1");
    assert.ok(turn.id !== undefined);
    assert.equal(await s.pauses.availability(cat), "available");
    // The member that was not woken is absent from the same record: it can neither join nor speak.
    const dogJoin = await call(dogToken, "meeting.record.join", { recordId: rec }, "dj1");
    assert.equal(dogJoin.ok, false, JSON.stringify(dogJoin));
    assert.match(dogJoin.error!.message, /may not take part in that meeting/);
    assert.equal((await call(dogToken, "meeting.record.append", { recordId: rec, kind: "statement", text: "Not here." }, "da1")).ok, false);
    assert.equal(await s.pauses.availability(dog), "stopped");

    // The meeting ends: the wake ends with it.
    await ok(ownerToken, "meeting.record.finish", { recordId: rec }, "mf1");
    await ok(ownerToken, "meeting.attend.end", { occurrenceId, decisions: [] }, "en1");
    assert.equal(await s.pauses.availability(cat), "stopped", "back to stopped as soon as the room ends");
    // The attempt's stop reaches the real worker, which answers the checkpoint: the stop FINISHES and the attempt ends.
    await until("the attempt's stop finishes", async () => { const a = await attemptOf(); return a === undefined || a.state === "finished"; }, tick);
    const ended = (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))!;
    assert.equal(ended.state, "finished", JSON.stringify(ended));
    assert.equal(ended.outcome?.status, "abandoned", JSON.stringify(ended.outcome));
    assert.deepEqual(await c.dispatch!.dispatcher.liveAttemptsOf(c.dispatch!.principal, { taskId }), [], "no attempt of the meeting task is alive");
    // A wake whose room is over and whose attempt has ended is settled: its lease record is removed and the owner lists nothing.
    await until("the wake is settled", async () => (await wakes()).length === 0, tick);

    // Back as it was: stopped, the same stop, the same grants, its other work held and never started, no other attempt.
    assert.equal(await s.pauses.availability(cat), "stopped");
    assert.equal(await stopOf(), lifecycleBefore, "the stop is the one the owner made");
    assert.equal(await grantsOf(), grantsBefore, "no grant changed");
    assert.equal(await s.pauses.isPaused(other.id), true);
    assert.equal(await s.pauses.isPaused(taskId), true, "the meeting task is held again by the stop");
    assert.equal((await s.assignments.getAssignment(other.id))?.activeAttemptId, undefined, "the held work never started");
    // The agent left the room when the wake ended: its seat says when, and it is not present.
    const seat = (await ok(ownerToken, "meeting.attend.status", { occurrenceId })).item.participants.find((p: any) => p.who === cat);
    assert.ok(seat?.leftAt !== undefined, JSON.stringify(seat));
  } finally { gate.resolve(); await x.close(); }
});

