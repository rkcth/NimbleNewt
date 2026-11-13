import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { ModelInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { EXEC_PROFILES, PI, ROUTING_TABLE, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const AGENT = "agt-abcdefghijklmnopqrst";

/** A controller with one agent whose first attempt is RUNNING (a scripted worker held open) and a second task with a waiting attempt. */
async function world(dispatcherExtra: Record<string, unknown> = {}, clock?: () => string) {
  const d = mkdtempSync(join(tmpdir(), "nn-safelong-"));
  const problems: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const worker = new ScriptedWorker("host:w1", async () => { await gate; return { status: "completed", text: "done" }; });
  // The one harness cannot abort a conversation, so only the rules under test decide what is deferred.
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [{ ...PI, abort: "none" as const }],
    dispatch: { timer: new ManualTimer(), manual: true, workers: [worker], dispatcher: dispatcherExtra as never, ...(clock === undefined ? {} : { clock }) }, onInternalError: (e) => { problems.push(e); },
  });
  const s = c.services;
  const boot = await s.principals.bootstrapOwner({ name: "rob" });
  const owner = await s.principals.authenticate(boot.token);
  await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" } } } as never);
  await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
  await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
  const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
  const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
  await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
  await hosts.heartbeat(hostP, { commandId: "hb", sequence: 1 });
  await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
  await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
  const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
  await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: AGENT, grants: [...workGrants(project), { action: "job.write", project }, { action: "job.control", project }, { action: "history.*", project }] });
  const task = async (n: number): Promise<{ taskId: string; attemptId: string }> => {
    const taskId = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title: `Order seeds ${n}` })).id;
    await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
    return { taskId, attemptId };
  };
  const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
  const close = async () => { release(); await c.dispatch?.dispatcher.idle(); await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); };
  return { c, s, owner, project, task, call, problems, close, worker, agent: `agent:${AGENT}` };
}

test("through the composed controller a running attempt with only background jobs carries on during a meeting, a new attempt never starts, an agent cannot admit a new long job on any task, and the setting turns the rule off (card M04g)", async () => {
  const w = await world();
  try {
    const { c, s, owner, project, call } = w;
    const first = await w.task(1);
    await c.dispatch!.dispatcher.tick();
    assert.equal((await c.dispatch!.dispatcher.get(owner, first.attemptId))!.state, "running");
    const carries = () => c.dispatch!.dispatcher.carriesOnDuringMeeting(first.attemptId, { conversationIdle: true });
    // A running background job exists, but no meeting concerns the agent yet.
    const jobId = (await s.jobs.admit(owner, { commandId: "ja", taskId: first.taskId, kind: "tool", label: "build", operationId: "op-1", background: true, attemptId: first.attemptId })).id;
    await s.jobs.report(owner, { commandId: "jr1", jobId, state: "dispatched", host: "host-1" });
    await s.jobs.report(owner, { commandId: "jr2", jobId, state: "running" });
    assert.equal(await carries(), false, "no meeting: nothing to carry on past");
    const meeting = await call("meeting.call-urgent", { projectId: project, title: "Hotfix", reason: "prod is down", roster: [w.agent] }, "mu1");
    assert.ok(meeting.ok, JSON.stringify(meeting));
    assert.equal(await carries(), true, "a running attempt with only a running background job carries on once its conversation is idle");
    assert.equal(await c.dispatch!.dispatcher.carriesOnDuringMeeting(first.attemptId, { conversationIdle: false }), false, "the worker is held open (busy): never carries on unless idleness is established");
    // The setting, chat-settable, turns the rule off and on.
    let rev: number | undefined;
    const set = async (n: string, value: unknown): Promise<void> => { const st = await s.configuration.stage(owner, { commandId: `${n}s`, layer: "installation", ...(rev === undefined ? {} : { expectedRevision: rev }), set: { "meeting.safeLongRunning": value } }); rev = (await s.configuration.apply(owner, { commandId: `${n}a`, layer: "installation", expectedRevision: st.revision })).revision; };
    await assert.rejects(set("bad", "yes"), /true or false/);
    await set("off", false);
    assert.equal(await carries(), false, "setting off");
    await set("on", true);
    assert.equal(await carries(), true);
    // A foreground job of the attempt makes it yield.
    await s.jobs.admit(owner, { commandId: "jb", taskId: first.taskId, kind: "tool", label: "interactive", operationId: "op-2", background: false, attemptId: first.attemptId });
    assert.equal(await carries(), false, "a foreground job: it yields");
    // A NEW attempt is deferred by the meeting even though the agent has a safe running job.
    const second = await w.task(2);
    const sj = (await s.jobs.admit(owner, { commandId: "jsafe", taskId: second.taskId, kind: "tool", label: "own", operationId: "op-own", background: true, attemptId: second.attemptId })).id;
    await s.jobs.report(owner, { commandId: "jsafe1", jobId: sj, state: "dispatched", host: "host-1" });
    await s.jobs.report(owner, { commandId: "jsafe2", jobId: sj, state: "running" });
    const tick = await c.dispatch!.dispatcher.tick();
    assert.ok([...tick.skipped, ...tick.blocked].some((x) => x.attemptId === second.attemptId && x.check === "meeting"), JSON.stringify(tick));
    assert.equal((await c.dispatch!.dispatcher.get(owner, second.attemptId))?.state !== "running", true);
    // The agent itself cannot admit a new background or long job on a task that is not the meeting's own; the owner still can.
    const ann = await s.principals.authenticate((await s.principals.issueCredential(owner, w.agent)).token);
    await assert.rejects(s.jobs.admit(ann, { commandId: "ja2", taskId: second.taskId, kind: "tool", label: "late", operationId: "op-3", background: true }), /long-running work is not started/);
    await assert.rejects(s.jobs.admit(ann, { commandId: "ja3", taskId: second.taskId, kind: "tool", label: "late", operationId: "op-4", longRunning: true }), /long-running work is not started/);
    // The gate fails closed when the meeting check itself fails.
    const real = c.dispatch!.attendance.admission.bind(c.dispatch!.attendance);
    (c.dispatch!.attendance as any).admission = async () => { throw new Error("store down"); };
    await assert.rejects(s.jobs.admit(ann, { commandId: "ja6", taskId: second.taskId, kind: "tool", label: "late", operationId: "op-7", background: true }), /could not be checked/);
    (c.dispatch!.attendance as any).admission = real;
    await s.jobs.admit(ann, { commandId: "ja4", taskId: second.taskId, kind: "tool", label: "short", operationId: "op-5" });
    await s.jobs.admit(owner, { commandId: "ja5", taskId: second.taskId, kind: "tool", label: "owner's", operationId: "op-6", background: true });
    assert.deepEqual(w.problems, []);
  } finally { await w.close(); }
});

test("an agent can admit a background job on any task when no meeting concerns it (card M04g)", async () => {
  const w = await world();
  try {
    const t = await w.task(1);
    const ann = await w.s.principals.authenticate((await w.s.principals.issueCredential(w.owner, w.agent)).token);
    await w.s.jobs.admit(ann, { commandId: "ja", taskId: t.taskId, kind: "tool", label: "build", operationId: "op-1", background: true });
  } finally { await w.close(); }
});

test("an explicit dispatcher.safeLongRunning wins over the composed one, and an explicit undefined key does not remove it (card M04g)", async () => {
  const seen: string[] = [];
  for (const [label, extra, expectCalls] of [["explicit", { safeLongRunning: async () => { seen.push("explicit"); return true; } }, ["explicit"]], ["undefined", { safeLongRunning: undefined }, []]] as const) {
    seen.length = 0;
    const w = await world(extra);
    try {
      const first = await w.task(1);
      await w.c.dispatch!.dispatcher.tick();
      const jobId = (await w.s.jobs.admit(w.owner, { commandId: "ja", taskId: first.taskId, kind: "tool", label: "b", operationId: "op-1", background: true, attemptId: first.attemptId })).id;
      await w.s.jobs.report(w.owner, { commandId: "jr1", jobId, state: "dispatched", host: "h" });
      assert.ok((await w.call("meeting.call-urgent", { projectId: w.project, title: "Hotfix", reason: "r", roster: [w.agent] }, "mu1")).ok);
      const carries = await w.c.dispatch!.dispatcher.carriesOnDuringMeeting(first.attemptId, { conversationIdle: true });
      assert.deepEqual(seen, expectCalls, label);
      assert.equal(carries, true, `${label}: the composed predicate (a dispatched background job) or the explicit one says yes`);
    } finally { await w.close(); }
  }
});

test("the gate refuses an agent's new long job from the notice before a planned meeting (inside leadMinutes, not yet started) and not before; lead 0 refuses only once it has started (card M04g)", async () => {
  let now = Date.parse("2026-11-02T07:00:00.000Z");
  const w = await world({}, () => new Date(now).toISOString());
  try {
    const { s, owner, project, call } = w;
    const t = await w.task(1);
    const ann = await s.principals.authenticate((await s.principals.issueCredential(owner, w.agent)).token);
    const sched = await call("meeting.schedule", { projectId: project, title: "Stand-up", roster: [w.agent], time: "08:00", timeZone: "UTC", recurrence: { kind: "once", date: "2026-11-02" } }, "ms1");
    assert.ok(sched.ok, JSON.stringify(sched));
    const tryJob = (n: string) => s.jobs.admit(ann, { commandId: `j-${n}`, taskId: t.taskId, kind: "tool", label: n, operationId: `op-${n}`, background: true }).then(() => "admitted", (e: Error) => e.message);
    now = Date.parse("2026-11-02T07:50:00.000Z");
    await w.c.dispatch!.dispatcher.tick();
    assert.equal(await tryJob("early"), "admitted", "ten minutes ahead: before the default five-minute notice");
    now = Date.parse("2026-11-02T07:56:00.000Z");
    await w.c.dispatch!.dispatcher.tick();
    assert.match(await tryJob("lead"), /long-running work is not started/, "four minutes ahead, planned and not started: refused");
    // Lead 0: the notice is gone; only a meeting that has started (or is about to within a minute) refuses.
    const st = await s.configuration.stage(owner, { commandId: "l0s", layer: "installation", set: { "meeting.leadMinutes": 0 } });
    await s.configuration.apply(owner, { commandId: "l0a", layer: "installation", expectedRevision: st.revision });
    assert.equal(await tryJob("l0-far"), "admitted", "lead 0: four minutes ahead is no longer inside any notice");
    now = Date.parse("2026-11-02T07:59:30.000Z");
    assert.match(await tryJob("l0-near"), /long-running work is not started/, "half a minute before the start");
    now = Date.parse("2026-11-02T08:10:00.000Z");
    assert.match(await tryJob("l0-on"), /long-running work is not started/, "while it is on");
  } finally { await w.close(); }
});

test("the controller's own host credential is held to the task owner's meeting like the agent (follow-up to T07: it used to skip the gate), and the owner is not", async () => {
  const w = await world();
  try {
    const { c, s, owner, project, call } = w;
    const t = await w.task(1);
    const host = c.dispatch!.principal;
    const tryJob = (as: typeof host, n: string, extra: object = { background: true }) => s.jobs.admit(as, { commandId: `j-${n}`, taskId: t.taskId, kind: "tool", label: n, operationId: `op-${n}`, ...extra } as never).then(() => "admitted", (e: Error) => e.message);
    assert.equal(await tryJob(host, "free"), "admitted", "no meeting: the host admits");
    assert.ok((await call("meeting.call-urgent", { projectId: w.project, title: "Hotfix", reason: "prod is down", roster: [w.agent] }, "mu1")).ok);
    assert.match(await tryJob(host, "bg"), /long-running work is not started/, "background job by the host credential, meeting on");
    assert.match(await tryJob(host, "long", { longRunning: true }), /long-running work is not started/);
    assert.equal(await tryJob(host, "short", {}), "admitted", "short work is not held");
    assert.equal(await tryJob(owner, "owner"), "admitted", "the owner is not held");
    void project;
    assert.deepEqual(w.problems, []);
  } finally { await w.close(); }
});

test("a restart decision from a checkpoint during a meeting is refused for the agent and leaves the job as it was; the owner may (follow-up to T07)", async () => {
  const w = await world();
  try {
    const { c, s, owner, call } = w;
    const t = await w.task(1);
    const ann = await s.principals.authenticate((await s.principals.issueCredential(owner, w.agent)).token);
    const id = (await s.jobs.admit(ann, { commandId: "ja", taskId: t.taskId, kind: "tool", label: "build", operationId: "op-1", resumability: "tool_checkpoint" })).id;
    await s.jobs.report(owner, { commandId: "jr", jobId: id, state: "dispatched", host: "host-1", checkpoint: "ckpt-1" });
    assert.ok((await call("meeting.call-urgent", { projectId: w.project, title: "Hotfix", reason: "prod is down", roster: [w.agent] }, "mu1")).ok);
    await assert.rejects(s.jobs.decide(ann, { commandId: "jd1", jobId: id, decision: "restart", reason: "go on" }), /long-running work is not started/);
    assert.equal((await s.jobs.get(owner, id))!.restarts, 0);
    await s.jobs.decide(ann, { commandId: "jd2", jobId: id, decision: "exception", reason: "owner follows", tracker: "owner" });
    assert.equal((await s.jobs.decide(owner, { commandId: "jd3", jobId: id, decision: "restart", reason: "owner says so" })).id, id);
    assert.equal((await s.jobs.get(owner, id))!.restarts, 1);
    assert.deepEqual(w.problems, []);
    void c;
  } finally { await w.close(); }
});

test("the composed gate's lock is the list every meeting creation rewrites: the first long job creates it empty and a meeting can still be called, and a lock read before a meeting no longer commits after it (T07 follow-up review: the gate raced a new meeting)", async () => {
  const w = await world();
  try {
    const { c, s, call } = w;
    const t = await w.task(1);
    const host = c.dispatch!.principal;
    const att = c.dispatch!.attendance;
    const commit = (label: string, changes: readonly unknown[]) => c.storage.applyOperation({
      operationId: label, epoch: c.epoch, actor: "test", correlationId: label, at: new Date().toISOString(), changes: changes as never,
      audit: [{ type: "test.lock", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
    });
    assert.equal((await att.meetingLocks())[0]!.type, "create", "before any meeting the list does not exist: the lock creates it empty");
    assert.equal((await s.jobs.admit(host, { commandId: "j-first", taskId: t.taskId, kind: "tool", label: "first", operationId: "op-first", background: true } as never)).replayed, false);
    const read = await att.meetingLocks();
    assert.equal(read[0]!.type, "check", "the admit created the list with the job");
    assert.ok((await call("meeting.call-urgent", { projectId: w.project, title: "Hotfix", reason: "prod is down", roster: [w.agent] }, "mu1")).ok, "a meeting is still called over the list the job made");
    await assert.rejects(commit("stale-lock", read), "a commit carrying the lock read before the meeting is refused");
    await assert.rejects(s.jobs.admit(host, { commandId: "j-after", taskId: t.taskId, kind: "tool", label: "after", operationId: "op-after", background: true } as never), /long-running work is not started/);
    assert.deepEqual(w.problems, []);
  } finally { await w.close(); }
});

test("through the composed controller a task whose idle attempt waits only on background jobs is noted as carrying on and is still paused by the meeting, so the agent writes nothing meanwhile; a task the owner paused is never noted (card M04h, review fix)", async () => {
  const w = await world();
  try {
    const { c, s, owner, project, call } = w;
    const first = await w.task(1);
    const other = await w.task(2);
    await c.dispatch!.dispatcher.tick();
    assert.equal((await c.dispatch!.dispatcher.get(owner, first.attemptId))!.state, "running");
    const jobId = (await s.jobs.admit(owner, { commandId: "ja", taskId: first.taskId, kind: "tool", label: "build", operationId: "op-1", background: true, attemptId: first.attemptId })).id;
    await s.jobs.report(owner, { commandId: "jr1", jobId, state: "dispatched", host: "host-1" });
    await s.jobs.report(owner, { commandId: "jr2", jobId, state: "running" });
    const handle = w.worker.handles.at(-1)!;
    handle.idle = async () => true;
    const meeting = await call("meeting.call-urgent", { projectId: project, title: "Hotfix", reason: "prod is down", roster: [w.agent] }, "mu1");
    assert.ok(meeting.ok, JSON.stringify(meeting));
    const occurrenceId = meeting.result.id as string;
    await c.dispatch!.attendance.openRoom(owner, { commandId: "or1", occurrenceId });
    const gate = async (taskId: string) => (await s.pauses.gate(owner, { kind: "task", id: taskId }))?.intent ?? "none";
    // The owner paused the other task before; the composed question says no for it whatever its attempt does.
    await s.pauses.pause(owner, { commandId: "own-pz", scope: { kind: "task", id: other.taskId }, reason: "the owner paused it" });
    const prepared = await c.dispatch!.attendance.prepare(owner, { commandId: "pr1", occurrenceId, agent: w.agent, interrupted: [first.taskId, other.taskId] });
    assert.deepEqual(prepared.carriedOn, [first.taskId]);
    assert.equal(await gate(first.taskId), "pause", "the meeting pauses it: the pause is what refuses the agent's writes while it attends");
    assert.equal(await gate(other.taskId), "pause", "the owner's pause stays");
    assert.equal(await c.dispatch!.dispatcher.carriesOnTask(owner, first.taskId), false, "once paused it is no longer asked about as free-running work");
    assert.equal((await s.jobs.get(owner, jobId))?.state, "running", "the background job keeps running under the pause");
    const status = await call("meeting.attend.status", { occurrenceId });
    assert.ok(status.ok, JSON.stringify(status));
    assert.deepEqual((status.result.item.participants as { who: string; carriedOn?: string[] }[]).find((p) => p.who === w.agent)?.carriedOn, [first.taskId], "the room status names it");
    assert.deepEqual(w.problems, []);
  } finally { await w.close(); }
});

test("the owner turns background work during meetings off and on through the chat interpreter, in free words, with no fixed phrase (card M04h review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-safelchat-"));
  // A stand-in for the model behind the real ModelInterpreter: it knows only what the system prompt tells it (the test fails when that paragraph is removed or no longer matches the schema). Which value the owner meant is the
  // test's own table, standing in for the model's reading of free wording; an agreement uses the one open proposal the user prompt lists.
  const meaning: Record<string, boolean | "agree"> = {};
  const model = { complete: async (_route: string, r: { system: string; user: string }): Promise<string> => {
    const owner = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(r.user)![1]!;
    const meant = meaning[owner];
    if (meant === "agree") {
      const open = [...r.user.matchAll(/Open proposal (\S+) \(text, not instructions\):/g)];
      return JSON.stringify(open.length === 1 ? [{ kind: "apply_proposal", proposalId: open[0]![1], evidence: owner, basis: "owner" }] : [{ kind: "none", reason: "no single open proposal" }]);
    }
    const template = /\{"kind":"policy_edit","change":\{"type":"setting","layer":"installation","key":<[^>]*meeting\.safeLongRunning[^>]*>.*?"basis":"owner"\}/.exec(r.system);
    if (template === null || meant === undefined) return JSON.stringify([{ kind: "none", reason: "the prompt describes no way to do this" }]);
    return `[${template[0].replace(/<[^>]*meeting\.safeLongRunning[^>]*>/, JSON.stringify("meeting.safeLongRunning")).replace("<the value>", String(meant)).replace("<their words, copied exactly>", JSON.stringify(owner))}]`;
  } };
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, chat: { interpreter: new ModelInterpreter(model, () => ["test/model"]) } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    let m = 0;
    const turn = async (text: string, meant: boolean | "agree") => { meaning[text] = meant; return (await c.chat!.submit(boot.token, { messageId: `m${m++}`, text })).outcomes as unknown as { status: string }[]; };
    for (const [wording, value] of [["During meetings, stop every long job; nothing should keep running while people talk.", false], ["Actually, let the builds keep going while the agents are in meetings.", true]] as const) {
      const shown = await turn(wording, value);
      assert.deepEqual(shown.map((o) => o.status), ["proposed"], `a setting is shown first: ${JSON.stringify(shown)}`);
      const done = await turn(`Yes, apply that (${String(value)}).`, "agree");
      assert.deepEqual(done.map((o) => o.status), ["applied"], JSON.stringify(done));
      assert.equal(await c.services.configuration.installationValue("meeting.safeLongRunning"), value);
    }
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
