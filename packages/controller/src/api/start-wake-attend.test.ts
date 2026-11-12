import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { stopServer } from "../domain/testing/backends.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { AdmissionService } from "../admission/service.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { PolicyService } from "../policy/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, workGrants } from "../dispatch/testing/world.js";
import { RemoteWorkerClient } from "../remote/index.js";
import { startTestServer, type TestServer } from "../storage/postgres/testing/server.js";
import { startController } from "./index.js";

after(stopServer);

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };

/** A controller with two agents and a daily meeting, composed with fixtures only (no model, no worker). `ann` is never stopped; `cat` is the one the tests stop and wake. */
async function fixture(storage: "sqlite" | { pg: TestServer }, extra: Record<string, unknown> = {}) {
  const d = mkdtempSync(join(tmpdir(), "nn-wakeatt-"));
  const slot = Date.parse(`${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T08:00:00.000Z`);
  let now = Date.now();
  const say: Record<string, unknown[]> = {};
  const choice = storage === "sqlite" ? { kind: "sqlite" as const, path: join(d, "c.sqlite") } : { kind: "postgres" as const, url: storage.pg.url(), schema: `wa_${process.pid}_${Math.random().toString(36).slice(2, 8)}` };
  const c = await startController({ storage: choice, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) }, ...extra,
    dispatch: { timer: new ManualTimer(), intervalMs: 1000, clock: () => new Date(now).toISOString(), invitations: { invite: async () => undefined },
      route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
      remote: { blobDirectory: join(d, "blobs"), hosts: [{ hostId: "host:pc", window: () => 131_072, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 256 }, requirements: () => ({ data: "cloud-allowed" as const, harness: "pi" }) }] } } } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const ids: Record<string, string> = {};
    for (const n of ["ann", "cat"]) {
      ids[n] = (await s.agents.create(rob, { commandId: `ag-${n}`, friendlyName: n })).id;
      await s.grants.grant(rob, { commandId: `g-${n}`, grantee: `agent:${ids[n]}`, action: "task.read", project, source: "direct", basis: "test" });
      for (const g of workGrants(project, ["read-file"])) await s.grants.grant(rob, { commandId: `w-${n}-${g.action}`, grantee: `agent:${ids[n]}`, action: g.action, project, source: "direct", basis: "test" } as never);
      await s.grants.grant(rob, { commandId: `h-${n}`, grantee: `agent:${ids[n]}`, action: "history.read", project, source: "direct", basis: "test" });
    }
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { message: string } }>;
    const made = await call("meeting.schedule", { projectId: project, title: "Stand-up", roster: ["ann", "cat"].map((n) => `agent:${ids[n]}`), time: "08:00", timeZone: "UTC", startDate: new Date(slot).toISOString().slice(0, 10), recurrence: { kind: "daily" } }, "ms1");
    assert.ok(made.ok, JSON.stringify(made));
    const open = async (): Promise<string> => {
      now = slot;
      for (let i = 0; i < 2; i++) await c.dispatch!.dispatcher.tick();
      const occurrenceId = (await call("meeting.schedule-get", { scheduleId: made.result.id })).result.item.lastOccurrenceId as string;
      const opened = await call("meeting.attend.open-room", { occurrenceId }, "or1"); assert.ok(opened.ok, JSON.stringify(opened));
      return occurrenceId;
    };
    /** A task of the agent that is in progress, the work a stop holds. */
    const work = async (n: string, title: string): Promise<string> => {
      const k = title.replace(/[^a-z0-9]/gi, "-");
      const t = await s.projects.createTask({ commandId: `t-${k}`, actor: rob.id, projectId: project, title, description: "work" });
      await s.projects.transitionTask({ commandId: `r-${k}`, actor: rob.id, taskId: t.id, expectedRevision: t.revision, to: "ready" });
      await s.assignments.assignTask({ commandId: `a-${k}`, actor: rob.id, taskId: t.id, owner: { kind: "agent", id: ids[n]! }, reason: "work" });
      return t.id;
    };
    /** The one fixture host that runs attempts: it answers for itself, no model is called. */
    await s.principals.enroll(rob, { commandId: "e-pc", kind: "host", name: "pc", grants: [] });
    const client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token: (await s.principals.issueCredential(rob, "host:pc")).token, workerVersion: "worker-9.1.0" });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-pc", actor: rob.id, host: "host:pc", capacity: { cpus: 32, memoryMb: 65_536 } });
    let connected = false, beat = 0;
    /** The host is heard from at the fixture's own time (the clock is moved to the meeting). */
    const hear = async () => { if (!connected) { await client.connect({ ...CAPS } as never); connected = true; } await client.heartbeat(++beat); };
    const seat = async (occurrenceId: string, agent: string) => ((await call("meeting.attend.status", { occurrenceId })).result.item.participants as any[]).find((a) => a.who === `agent:${ids[agent]}`);
    const pass = async (n = 1) => { const out = []; for (let i = 0; i < n; i++) { await hear(); out.push(await c.dispatch!.dispatcher.tick()); } return out; };
    return { c, call, ids, rob, project, say, boot, open, seat, work, pass, advance: (ms: number) => { now += ms; }, availability: (n: string) => c.services.pauses.availability(`agent:${ids[n]}`), close: async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
  } catch (e) { await c.close(); throw e; }
}

const wakes = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.call("meeting.attend.wakes", {})).result.item as any[];

const attemptOf = async (f: Awaited<ReturnType<typeof fixture>>, taskId: string) => {
  const a = await f.c.services.assignments.getAssignment(taskId);
  return a?.activeAttemptId === undefined ? undefined : (await f.c.dispatch!.dispatcher.get(f.c.dispatch!.principal, a.activeAttemptId));
};

async function wholeFlow(storage: "sqlite" | { pg: TestServer }): Promise<void> {
  const f = await fixture(storage);
  try {
    const { call, ids } = f;
    const cat = `agent:${ids["cat"]}`;
    const other = await f.work("cat", "other work");
    assert.ok((await call("lifecycle.stop", { scope: { kind: "agent", id: ids["cat"] }, mode: "stop", reason: "night" }, "st1")).ok);
    const occurrenceId = await f.open();
    assert.deepEqual(await wakes(f), [], "nothing is woken yet");
    assert.ok((await call("meeting.attend.wake", { occurrenceId, agent: cat }, "wk1")).ok);
    const before = await wakes(f);
    assert.equal(before.length, 1);
    assert.equal(before[0].state, "waiting");
    assert.equal((await f.seat(occurrenceId, "cat")).state, "preparing");
    const reports = await f.pass(3);
    const now = (await wakes(f))[0];
    assert.equal(now.state, "attending", JSON.stringify(now));
    const seat = await f.seat(occurrenceId, "cat");
    assert.equal(seat.state, "present", JSON.stringify(seat));
    assert.equal(seat.bounded, true);
    // The meeting task may run past the stop, and nothing else of the agent: its own work stays held.
    assert.equal(await f.c.services.pauses.isPaused(now.meetingTaskId), false, "the bounded meeting task is not held by the stop");
    assert.equal(await f.c.services.pauses.isPaused(other), true, "the work the stop holds stays held");
    // The attempt goes through the dispatcher's ordinary checks and starts on the host: the wake has no other door.
    const attempt = await attemptOf(f, now.meetingTaskId);
    assert.ok(attempt !== undefined, "an attempt was admitted for the meeting task");
    assert.deepEqual(reports.flatMap((r) => r.started), [attempt.attemptId]);
    assert.equal(attempt.state, "running");
    assert.equal((await attemptOf(f, other)), undefined, "no attempt exists for the held work");
    // The owner ends the wake: at rest at once, out of the room, the permission ended, and the attempt stops.
    const stop = await call("meeting.attend.wake-stop", { occurrenceId, agent: cat }, "ws1");
    assert.ok(stop.ok, JSON.stringify(stop));
    assert.equal(await f.availability("cat"), "stopped");
    assert.equal((await wakes(f))[0].state, "stopped");
    assert.equal(await f.c.services.pauses.isPaused(now.meetingTaskId), true, "the permission ended with the wake");
    await f.pass(2);
    // The attempt is stopped through the dispatcher's own stop (it is frozen at once with the reason); the fixture host never answers the request for a checkpoint, so the stop is not finished and the host tries again on the next pass.
    const frozen = (await attemptOf(f, now.meetingTaskId))!;
    assert.ok(frozen.frozen !== undefined, "the dispatcher froze the attempt of the stopped wake");
    assert.match(String(JSON.stringify(frozen.frozen)), /the owner stopped the wake/);
    assert.ok((await call("meeting.attend.wake-stop", { occurrenceId, agent: cat }, "ws1")).ok, "a repeat is the same stop");
    assert.equal(await f.availability("ann"), "available");
  } finally { await f.close(); }
}

test("the controller brings a woken stopped agent into the room through the bounded meeting task and the dispatcher; its other work stays held, the owner sees it and ends it (card M04h)", async () => { await wholeFlow("sqlite"); });

test("the same flow on PostgreSQL (card M04h)", async () => {
  const pg = await startTestServer();
  try { await wholeFlow({ pg }); } finally { await pg.stop(); }
});

test("only the owner sees or ends a wake; an agent's own credential is refused (card M04h)", async () => {
  const f = await fixture("sqlite");
  try {
    const { call, ids } = f;
    const cat = `agent:${ids["cat"]}`;
    assert.ok((await call("lifecycle.stop", { scope: { kind: "agent", id: ids["cat"] }, mode: "stop", reason: "night" }, "st1")).ok);
    const occurrenceId = await f.open();
    assert.ok((await call("meeting.attend.wake", { occurrenceId, agent: cat }, "wk1")).ok);
    const token = (await f.c.services.principals.issueCredential(f.rob, `agent:${ids["ann"]}`)).token;
    const as = (op: string, args: Record<string, unknown>, commandId?: string) => f.c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; error?: { code: string } }>;
    assert.equal((await as("meeting.attend.wakes", {})).ok, false);
    const stop = await as("meeting.attend.wake-stop", { occurrenceId, agent: cat }, "x1");
    assert.equal(stop.ok, false);
    assert.equal(stop.error!.code, "forbidden");
    assert.equal(await f.availability("cat"), "available", "nothing changed");
    const viewed = await as("status.ask", { request: { kind: "wakes" } });
    assert.equal(viewed.ok, false);
    assert.equal(viewed.error!.code, "not_found", "an agent is shown no wake");
    const ownerView = await call("status.ask", { request: { kind: "wakes" } });
    assert.ok(ownerView.ok, JSON.stringify(ownerView));
    assert.match(JSON.stringify(ownerView), /waiting to be brought into the room/);
    // Unknown fields and a wake that does not exist are refused in plain words.
    const none = await call("meeting.attend.wake-stop", { occurrenceId, agent: `agent:${ids["ann"]}` }, "x2");
    assert.equal(none.ok, false);
    assert.match(none.error!.message, /has no wake for that meeting/);
  } finally { await f.close(); }
});

test("a wake host the application supplies is the only one: the controller starts nothing for it and has no wakes to show or stop (card M04h)", async () => {
  const recovered: string[] = [];
  const f = await fixture("sqlite", { meetingWake: { recover: async (r: { key: string }) => { recovered.push(r.key); } } });
  try {
    const { call, ids } = f;
    assert.deepEqual((await call("meeting.attend.wakes", {})).result.item, []);
    const stop = await call("meeting.attend.wake-stop", { occurrenceId: "mto-aaaaaaaaaaaaaaaaaaaa", agent: `agent:${ids["cat"]}` }, "x1");
    assert.equal(stop.ok, false);
    assert.match(stop.error!.message, /no wake of the controller's own host/);
    const tick = await f.pass(1);
    assert.equal(tick[0]!.loops.some((l) => l.name === "meeting.wake-attend"), false, "the loop is not composed");
  } finally { await f.close(); }
});

test("the owner wakes, sees and ends a wake in free words in chat: a wake follows the profile, seeing it is a status view, ending it applies at once (card M04h)", async () => {
  const f = await fixture("sqlite");
  try {
    const { call, ids, say, boot } = f;
    const chat = f.c.chat!;
    const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
    const turn = async (text: string) => { const r = await chat.submit(boot.token, { messageId: `m-${text.length}-${Math.abs([...text].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7))}`, text }); assert.equal(r.outcomes.length, 1, JSON.stringify(r)); return r.outcomes[0]! as unknown as { status: string; op?: string; summary?: string } & Record<string, unknown>; };
    await chat.setFocus(boot.token, { commandId: "focus", projectId: f.project });
    assert.ok((await call("lifecycle.stop", { scope: { kind: "agent", id: ids["cat"] }, mode: "stop", reason: "night" }, "st1")).ok);
    await f.open();
    // The strict profile shows a wake first, with what it means, and starts nothing.
    await PolicyService.withEpoch(f.c.storage, f.c.epoch, f.c.services.grants).set(f.rob, { scope: "installation", commandId: "pol1", profile: "strict" } as never);
    say["Get cat in for the stand-up even though she is stopped."] = [cmd("meeting.attend.wake", { meetingTopic: "stand-up", agentName: "cat" }, "Get cat in for the stand-up")];
    const shown = await turn("Get cat in for the stand-up even though she is stopped.");
    assert.equal(shown.status, "proposed", JSON.stringify(shown));
    assert.match(JSON.stringify(shown), /this meeting only, then the agent is back as it was/);
    assert.equal(await f.availability("cat"), "stopped", "nothing was woken by a proposal");
    // Where the profile lets it through, it is done.
    await PolicyService.withEpoch(f.c.storage, f.c.epoch, f.c.services.grants).set(f.rob, { scope: "installation", commandId: "pol2", expectedRevision: 1, profile: "autonomous" } as never);
    say["Please wake cat for the stand-up."] = [cmd("meeting.attend.wake", { meetingTopic: "stand-up", agentName: "cat" }, "wake cat for the stand-up")];
    const woke = await turn("Please wake cat for the stand-up.");
    assert.equal(woke.status, "applied", JSON.stringify(woke));
    assert.equal(await f.availability("cat"), "available");
    await f.pass(2);
    // Seeing it is a status view the interpreter is offered like every other.
    say["Who is awake for a meeting?"] = [{ kind: "status", request: { kind: "wakes" }, evidence: "Who is awake for a meeting", basis: "owner" }];
    const seen = await turn("Who is awake for a meeting?");
    assert.match(JSON.stringify(seen), /is attending the meeting/);
    assert.match(JSON.stringify(seen), /Stand-up/);
    // Ending it is applied at once; a name that is nobody's is refused and nothing is guessed.
    say["Let cat go back to sleep."] = [cmd("meeting.attend.wake-stop", { agentName: "cat" }, "Let cat go back to sleep")];
    const ended = await turn("Let cat go back to sleep.");
    assert.equal(ended.status, "applied", JSON.stringify(ended));
    assert.equal(await f.availability("cat"), "stopped");
    say["Let zed go back to sleep."] = [cmd("meeting.attend.wake-stop", { agentName: "zed" }, "Let zed go back to sleep")];
    assert.equal((await turn("Let zed go back to sleep.")).status, "refused");
    say["Who is awake now?"] = [{ kind: "status", request: { kind: "wakes" }, evidence: "Who is awake now", basis: "owner" }];
    assert.match(JSON.stringify(await turn("Who is awake now?")), /You stopped the wake of/);
  } finally { await f.close(); }
});

/** Review of card M04h: a Stop, Suspend or Force Stop the owner makes after the wake keeps the gate's pause (and so its request), and must still win over the meeting task's permission. */
async function laterStop(storage: "sqlite" | { pg: TestServer }, later: "force" | "stop-after-suspend" | "before-join"): Promise<void> {
  const f = await fixture(storage);
  try {
    const { call, ids } = f;
    const cat = `agent:${ids["cat"]}`;
    assert.ok((await call("lifecycle.stop", { scope: { kind: "agent", id: ids["cat"] }, mode: later === "stop-after-suspend" ? "suspend" : "stop", reason: "night" }, "st1")).ok);
    const occurrenceId = await f.open();
    assert.ok((await call("meeting.attend.wake", { occurrenceId, agent: cat }, "wk1")).ok);
    const again = async () => {
      const r = later === "stop-after-suspend" ? await call("lifecycle.stop", { scope: { kind: "agent", id: ids["cat"] }, mode: "stop", reason: "again" }, "st2") : await call("lifecycle.force", { scope: { kind: "agent", id: ids["cat"] }, reason: "again" }, "fs1");
      assert.ok(r.ok, JSON.stringify(r));
    };
    if (later === "before-join") {
      await again();
      await f.pass(3);
      const w = (await wakes(f))[0];
      assert.equal(w.state, "gave-up", JSON.stringify(w));
      assert.match(w.reason, /stopped, suspended or paused again after the wake/);
      assert.notEqual((await f.seat(occurrenceId, "cat")).state, "present", "the agent was never brought in");
      assert.equal(w.meetingTaskId, undefined);
      return;
    }
    await f.pass(3);
    const w = (await wakes(f))[0];
    assert.equal(w.state, "attending", JSON.stringify(w));
    assert.equal(await f.c.services.pauses.isPaused(w.meetingTaskId), false);
    await again();
    // The later stop holds the meeting task at once, before any pass of the host: the permission does not cover a stop made after it.
    assert.equal(await f.c.services.pauses.isPaused(w.meetingTaskId), true, "the owner's later stop holds the meeting task");
    await f.pass(2);
    const after = (await wakes(f))[0];
    assert.equal(after.state, "ended", JSON.stringify(after));
    assert.match(after.reason, /stopped, suspended or paused this agent again/);
    assert.notEqual((await f.seat(occurrenceId, "cat")).state, "present", "the agent left the room");
    assert.equal(await f.c.services.pauses.isPaused(w.meetingTaskId), true);
    const attempt = await attemptOf(f, w.meetingTaskId);
    assert.ok(attempt === undefined || attempt.frozen !== undefined || attempt.state !== "running", `no attempt runs on: ${JSON.stringify(attempt)}`);
    assert.match(JSON.stringify(await f.call("status.ask", { request: { kind: "wakes" } })), /its wake has ended/);
  } finally { await f.close(); }
}

for (const later of ["force", "stop-after-suspend", "before-join"] as const) {
  test(`a later ${later} of the woken agent wins over its meeting permission and the wake says so (card M04h review)`, async () => { await laterStop("sqlite", later); });
}
test("a later stop wins on PostgreSQL too (card M04h review)", async () => {
  const pg = await startTestServer();
  try { for (const later of ["force", "stop-after-suspend"] as const) await laterStop({ pg }, later); } finally { await pg.stop(); }
});
