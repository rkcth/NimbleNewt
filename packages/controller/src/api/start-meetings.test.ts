import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { InvitationInbox } from "../meetings/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a schedule made through the state API is held once per slot by the composed dispatcher, a restart and catch-up add no second occurrence (card M01)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-meet-"));
  const file = join(d, "c.sqlite");
  // The API's own services read the real clock (the schedule's start is real now); the dispatcher's clock is moved from there.
  const day = 86_400_000;
  const at = (offsetDays: number, hhmm: string): number => Date.parse(`${new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10)}T${hhmm}:00.000Z`);
  let now = Date.now();
  const clock = (): string => new Date(now).toISOString();
  const open = () => startController({ storage: { kind: "sqlite", path: file }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000, clock } });
  let c = await open();
  let token = "";
  let project = "";
  let scheduleId = "";
  let first = "";
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    token = boot.token;
    const rob = await c.services.principals.authenticate(token);
    project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    for (const n of ["ann", "bob"]) await c.services.principals.enroll(rob, { commandId: `e-${n}`, kind: "agent", name: n, grants: [{ action: "task.read", project }] });
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    const made = await call("meeting.schedule", { projectId: project, title: "Stand-up", roster: ["agent:ann", "agent:bob"], time: "08:00", timeZone: "UTC", startDate: new Date(at(1, "00:00")).toISOString().slice(0, 10), recurrence: { kind: "daily" } }, "ms1");
    assert.ok(made.ok, JSON.stringify(made));
    scheduleId = made.result.id;
    assert.equal((await call("meeting.schedule", { projectId: project, title: "Stand-up", roster: ["agent:ann", "agent:bob"], time: "08:00", timeZone: "UTC", startDate: new Date(at(1, "00:00")).toISOString().slice(0, 10), recurrence: { kind: "daily" } }, "ms1")).result.replayed, true);
    assert.ok((await call("meeting.schedule-get", { scheduleId })).ok);
    // An agent without meeting.manage cannot schedule.
    const annToken = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    assert.equal(((await c.api.handle(annToken, { v: 1, op: "meeting.schedule", commandId: "ms2", args: { projectId: project, title: "X", roster: ["agent:bob"], time: "08:00", timeZone: "UTC" } } as never)) as { ok: boolean; error?: { code: string } }).error?.code, "forbidden");
    // An urgent call is accepted from the manager and recorded with its roster (absent and paused participants are withheld, which meetings.test.ts proves with real agent records).
    const urgent = await call("meeting.call-urgent", { projectId: project, title: "Hotfix", reason: "prod is down", roster: ["agent:ann", "agent:bob"] }, "mu1");
    assert.ok(urgent.ok, JSON.stringify(urgent));
    assert.ok((await call("meeting.occurrence", { occurrenceId: urgent.result.id })).ok);
    // Before the slot nothing is planned.
    await c.dispatch!.dispatcher.tick();
    assert.equal((await call("meeting.schedule-get", { scheduleId })).result.item.occurrences, 0, "nothing before the slot");
    now = at(1, "08:00");
    const rep = await c.dispatch!.dispatcher.tick();
    assert.ok(rep.loops.every((l) => l.ok), JSON.stringify(rep.loops));
    await c.dispatch!.dispatcher.tick();
    const count = async (): Promise<number> => (await call("meeting.schedule-get", { scheduleId })).result.item.occurrences;
    assert.equal(await count(), 1, "one occurrence for the slot, however often the clock ticked");
    first = (await call("meeting.schedule-get", { scheduleId })).result.item.lastOccurrenceId;
    const firstOcc = (await call("meeting.occurrence", { occurrenceId: first })).result.item.occurrence;
    assert.notEqual(firstOcc.mode, "catch-up", "the slot was met on time, not caught up");
    assert.ok((await call("meeting.planned", { projectId: project })).ok);
  } finally { await c.close(); }
  try {
    // A restart two days on: catch-up creates one occurrence that names the skipped slots, not one per missed slot; ticking again adds none.
    now = at(3, "09:00");
    c = await open();
    const call = (op: string, args: Record<string, unknown>) => c.api.handle(token, { v: 1, op, args } as never) as Promise<{ ok: boolean; result?: any }>;
    const count = async (): Promise<number> => (await call("meeting.schedule-get", { scheduleId })).result.item.occurrences;
    await c.dispatch!.dispatcher.tick();
    await c.dispatch!.dispatcher.tick();
    assert.equal(await count(), 2, "one catch-up occurrence for the days missed, not one per missed slot");
    const last = (await call("meeting.schedule-get", { scheduleId })).result.item.lastOccurrenceId;
    const lastOcc = (await call("meeting.occurrence", { occurrenceId: last })).result.item.occurrence;
    assert.equal(lastOcc.mode, "catch-up");
    assert.ok(lastOcc.skippedCount >= 1, JSON.stringify(lastOcc));
    assert.notEqual(last, first, "a new occurrence, not the first one again");
    await c.close();
    c = await open();
    await c.dispatch!.dispatcher.tick();
    assert.equal(await count(), 2, "a second restart creates nothing more");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a schedule that names no zone uses the owner's meeting.timeZone setting, and an urgent meeting's invitations reach the agent through the composed inbox, once, and only to the one it is for (card M01c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-meet-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const ann = (await s.agents.create(rob, { commandId: "ag-ann", friendlyName: "Ann" })).id;
    const bob = (await s.agents.create(rob, { commandId: "ag-bob", friendlyName: "Bob" })).id;
    for (const id of [ann, bob]) await s.grants.grant(rob, { commandId: `g-${id}`, grantee: `agent:${id}`, action: "task.read", project, source: "direct", basis: "test" });
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
    // No zone and no setting: refused with the reason. Then the owner sets it and the same request works, with the zone recorded as the owner's.
    const sched = { projectId: project, title: "Stand-up", roster: [`agent:${ann}`], time: "09:00" };
    const refused = await call(boot.token, "meeting.schedule", sched, "ms0");
    assert.equal(refused.ok, false);
    assert.match(refused.error!.message, /meeting.timeZone/);
    const staged = await s.configuration.stage(rob, { commandId: "cfg1", layer: "installation", set: { "meeting.timeZone": "Asia/Kolkata" } });
    await s.configuration.apply(rob, { commandId: "cfg2", layer: "installation", expectedRevision: staged.revision });
    const made = await call(boot.token, "meeting.schedule", sched, "ms1");
    assert.ok(made.ok, JSON.stringify(made));
    const got = (await call(boot.token, "meeting.schedule-get", { scheduleId: made.result.id })).result.item;
    assert.deepEqual([got.timeZone, got.timeZoneFromOwnerSetting], ["Asia/Kolkata", true]);
    // An urgent meeting for Ann and Bob: both are invited by the dispatcher's tick; each reads only its own, the owner reads either, a task credential none.
    const urgent = await call(boot.token, "meeting.call-urgent", { projectId: project, title: "Hotfix", reason: "prod is down", roster: [`agent:${ann}`, `agent:${bob}`] }, "mu1");
    assert.ok(urgent.ok, JSON.stringify(urgent));
    for (let i = 0; i < 3; i++) await c.dispatch!.dispatcher.tick();
    const annToken = (await s.principals.issueCredential(rob, `agent:${ann}`)).token;
    const mine = await call(annToken, "meeting.invitations", { agent: `agent:${ann}` });
    assert.ok(mine.ok, JSON.stringify(mine));
    assert.deepEqual(mine.result.items.map((i: { agent: string; occurrenceId: string; urgent: boolean }) => [i.agent, i.occurrenceId, i.urgent]), [[`agent:${ann}`, urgent.result.id, true]], "one invitation, however often the dispatcher ticked");
    assert.deepEqual((await call(annToken, "meeting.invitations", { agent: `agent:${bob}` })).result.items, [], "not Bob's");
    assert.equal((await call(boot.token, "meeting.invitations", { agent: `agent:${bob}` })).result.items.length, 1, "the owner reads Bob's");
    // The same key delivered again (a retry after a sink fault) adds nothing, even with a changed body; a different key adds one, newest first; only the newest 50 are kept.
    const inbox = InvitationInbox.withEpoch(c.storage, c.epoch);
    const one = mine.result.items[0];
    await inbox.invite({ ...one, urgent: false });
    assert.equal((await call(annToken, "meeting.invitations", { agent: `agent:${ann}` })).result.items.length, 1);
    for (let i = 0; i < 55; i++) await inbox.invite({ ...one, key: `${one.key}:${i}`, startsAt: new Date(Date.UTC(2030, 0, 1 + i)).toISOString() });
    const kept = (await call(annToken, "meeting.invitations", { agent: `agent:${ann}` })).result.items;
    assert.equal(kept.length, 50);
    assert.equal(kept[0].key, `${one.key}:54`, "latest sent first");
    // A task credential of that agent reads its own list (its project's invitations only); another agent's task credential reads nothing of Ann's.
    const taskFor = (agentId: string) => {
      return { kind: "agent" as const, id: `agent:${agentId}`, name: agentId, grants: [], taskScope: { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: project } };
    };
    const annTask = taskFor(ann);
    assert.equal((await inbox.forAgent(annTask as never, `agent:${ann}`)).length, 50, "a task credential of Ann reads Ann's list");
    assert.deepEqual(await inbox.forAgent(taskFor(bob) as never, `agent:${ann}`), [], "and Bob's reads none of it");
    const elsewhere = { ...annTask, taskScope: { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: "proj-aaaaaaaaaaaaaaaaaaaa" } };
    assert.deepEqual(await inbox.forAgent(elsewhere as never, `agent:${ann}`), [], "a task credential of another project sees none of this project's");
    // Invitations delivered at the same moment are all kept.
    await Promise.all([1, 2, 3, 4].map((n) => inbox.invite({ ...one, agent: `agent:${bob}`, key: `${one.key}:c${n}` })));
    assert.equal((await call(boot.token, "meeting.invitations", { agent: `agent:${bob}` })).result.items.length, 5);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("through the composed controller a paused agent and an agent the host reports stopped are withheld from a scheduled meeting and not woken, and an agenda item taken by the occurrence is still open after it is settled (card M01b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-meet-"));
  const day = 86_400_000;
  const slot = Date.parse(`${new Date(Date.now() + day).toISOString().slice(0, 10)}T08:00:00.000Z`);
  let now = Date.now();
  const stopped = new Set<string>();
  const sent: string[] = [];
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], availability: async (id) => (stopped.has(id) ? "stopped" : "available"), dispatch: { timer: new ManualTimer(), intervalMs: 1000, clock: () => new Date(now).toISOString(), invitations: { invite: async (i) => { sent.push(i.agent); } } } });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const ids: Record<string, string> = {};
    for (const n of ["ann", "bob", "cat"]) {
      ids[n] = (await s.agents.create(rob, { commandId: `ag-${n}`, friendlyName: n })).id;
      await s.grants.grant(rob, { commandId: `g-${n}`, grantee: `agent:${ids[n]}`, action: "task.read", project, source: "direct", basis: "test" });
    }
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { message: string } }>;
    const topic = await call("agenda.capture", { projectId: project, topic: "Fence repairs", question: "who pays?" }, "ag1");
    assert.ok(topic.ok, JSON.stringify(topic));
    const made = await call("meeting.schedule", { projectId: project, title: "Stand-up", roster: ["ann", "bob", "cat"].map((n) => `agent:${ids[n]}`), time: "08:00", timeZone: "UTC", startDate: new Date(slot).toISOString().slice(0, 10), recurrence: { kind: "daily" } }, "ms1");
    assert.ok(made.ok, JSON.stringify(made));
    // Bob is paused by the owner; the host reports Cat stopped. Ann is available.
    await s.pauses.pause(rob, { commandId: "pz", scope: { kind: "agent", id: ids.bob! }, reason: "the owner asked" });
    stopped.add(`agent:${ids.cat}`);
    now = slot;
    for (let i = 0; i < 2; i++) await c.dispatch!.dispatcher.tick();
    const sched = (await call("meeting.schedule-get", { scheduleId: made.result.id })).result.item;
    assert.equal(sched.occurrences, 1);
    const occ = (await call("meeting.occurrence", { occurrenceId: sched.lastOccurrenceId })).result.item.occurrence;
    const status = (n: string): string => occ.participants.find((p: { id: string }) => p.id === `agent:${ids[n]}`).status;
    assert.deepEqual([status("ann"), status("bob"), status("cat")], ["eligible", "withheld-paused", "withheld-unavailable"]);
    assert.equal(await s.pauses.availability(`agent:${ids.bob}`), "paused", "being withheld did not lift the pause");
    assert.deepEqual(sent, [`agent:${ids.ann}`], "only the available agent was invited; the paused and the stopped one were not");
    assert.deepEqual(occ.agenda, [topic.result.id], "the occurrence took the agenda item");
    assert.deepEqual((await call("agenda.list", { projectId: project })).result.items, [], "and it is off the open agenda while the occurrence holds it");
    // The owner's request ahead of time reaches the room through the state API (so the chat can make it): the paused agent is let in for this meeting; the one the host reports stopped is not woken by it (card M04e).
    const invited = await call("meeting.invite-direct", { occurrenceId: sched.lastOccurrenceId, agent: `agent:${ids.bob}` }, "iv1");
    assert.ok(invited.ok, JSON.stringify(invited));
    const seats = (await call("meeting.occurrence", { occurrenceId: sched.lastOccurrenceId })).result.item.occurrence.participants;
    assert.equal(seats.find((p: { id: string }) => p.id === `agent:${ids.bob}`).status, "owner-invited");
    const refusedCat = await call("meeting.invite-direct", { occurrenceId: sched.lastOccurrenceId, agent: `agent:${ids.cat}` }, "iv2");
    assert.equal(refusedCat.ok, false);
    // Settled without reaching it: the item is still open for the next meeting.
    assert.ok((await call("meeting.settle", { occurrenceId: sched.lastOccurrenceId, outcome: "cancelled", reason: "nobody came" }, "st1")).ok);
    const open = await call("agenda.list", { projectId: project });
    assert.deepEqual(open.result.items.map((i: { id: string }) => i.id), [topic.result.id]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("through the composed controller the owner's wake of an agent the host reports stopped reaches the host once, and without a host wake path it is refused (card M04f)", async () => {
  for (const withHost of [true, false]) {
    const d = mkdtempSync(join(tmpdir(), "nn-meet-"));
    const slot = Date.parse(`${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T08:00:00.000Z`);
    let now = Date.now();
    const stopped = new Set<string>();
    const recovered: { key: string; agent: string }[] = [];
    const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], availability: async (id: string) => (stopped.has(id) ? "stopped" : "available"),
      ...(withHost ? { meetingWake: { recover: async (r: { key: string; agent: string }) => { recovered.push({ key: r.key, agent: r.agent }); } } } : {}),
      dispatch: { timer: new ManualTimer(), intervalMs: 1000, clock: () => new Date(now).toISOString(), invitations: { invite: async () => undefined } } } as never);
    try {
      const s = c.services;
      const boot = await s.principals.bootstrapOwner({ name: "rob" });
      const rob = await s.principals.authenticate(boot.token);
      const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
      const ids: Record<string, string> = {};
      for (const n of ["ann", "cat"]) {
        ids[n] = (await s.agents.create(rob, { commandId: `ag-${n}`, friendlyName: n })).id;
        await s.grants.grant(rob, { commandId: `g-${n}`, grantee: `agent:${ids[n]}`, action: "task.read", project, source: "direct", basis: "test" });
        await s.grants.grant(rob, { commandId: `h-${n}`, grantee: `agent:${ids[n]}`, action: "history.read", project, source: "direct", basis: "test" });
      }
      const call = (op: string, args: Record<string, unknown>, commandId?: string, token = boot.token) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { message: string } }>;
      const made = await call("meeting.schedule", { projectId: project, title: "Stand-up", roster: ["ann", "cat"].map((n) => `agent:${ids[n]}`), time: "08:00", timeZone: "UTC", startDate: new Date(slot).toISOString().slice(0, 10), recurrence: { kind: "daily" } }, "ms1");
      assert.ok(made.ok, JSON.stringify(made));
      stopped.add(`agent:${ids.cat}`);
      now = slot;
      for (let i = 0; i < 2; i++) await c.dispatch!.dispatcher.tick();
      const occurrenceId = (await call("meeting.schedule-get", { scheduleId: made.result.id })).result.item.lastOccurrenceId;
      const opened = await call("meeting.attend.open-room", { occurrenceId }, "or1"); assert.ok(opened.ok, JSON.stringify(opened));
      const wake = await call("meeting.attend.wake", { occurrenceId, agent: `agent:${ids.cat}` }, "wk1");
      if (!withHost) { assert.equal(wake.ok, false); assert.match(wake.error!.message, /no wake path/); assert.deepEqual(recovered, []); continue; }
      assert.ok(wake.ok, JSON.stringify(wake));
      assert.deepEqual(recovered, [{ key: `${occurrenceId}:agent:${ids.cat}:1`, agent: `agent:${ids.cat}` }]);
      // The agent that is available needs no wake, and nothing else reached the host.
      const avail = await call("meeting.attend.wake", { occurrenceId, agent: `agent:${ids.ann}` }, "wk2");
      assert.equal(avail.ok, false);
      assert.equal(avail.error!.message, `agent:${ids.ann} is available; only a suspended or stopped agent needs the owner's wake`);
      assert.equal(recovered.length, 1);
      // The same command sent again is a replay: it never makes a second wake.
      assert.ok((await call("meeting.attend.wake", { occurrenceId, agent: `agent:${ids.cat}` }, "wk1")).ok);
      assert.ok(recovered.every((r) => r.key === `${occurrenceId}:agent:${ids.cat}:1`));
    } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }
});

async function wakeFixture(hook: { recover: (r: { key: string; agent: string }) => Promise<void>; timeoutMs?: number }) {
  const d = mkdtempSync(join(tmpdir(), "nn-meet-"));
    const slot = Date.parse(`${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T08:00:00.000Z`);
    let now = Date.now();
    const stopped = new Set<string>();
        const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], availability: async (id: string) => (stopped.has(id) ? "stopped" : "available"),
      meetingWake: hook,
      dispatch: { timer: new ManualTimer(), intervalMs: 1000, clock: () => new Date(now).toISOString(), invitations: { invite: async () => undefined } } } as never);
    try {
      const s = c.services;
      const boot = await s.principals.bootstrapOwner({ name: "rob" });
      const rob = await s.principals.authenticate(boot.token);
      const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
      const ids: Record<string, string> = {};
      for (const n of ["ann", "cat"]) {
        ids[n] = (await s.agents.create(rob, { commandId: `ag-${n}`, friendlyName: n })).id;
        await s.grants.grant(rob, { commandId: `g-${n}`, grantee: `agent:${ids[n]}`, action: "task.read", project, source: "direct", basis: "test" });
        await s.grants.grant(rob, { commandId: `h-${n}`, grantee: `agent:${ids[n]}`, action: "history.read", project, source: "direct", basis: "test" });
      }
      const call = (op: string, args: Record<string, unknown>, commandId?: string, token = boot.token) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { message: string } }>;
      const made = await call("meeting.schedule", { projectId: project, title: "Stand-up", roster: ["ann", "cat"].map((n) => `agent:${ids[n]}`), time: "08:00", timeZone: "UTC", startDate: new Date(slot).toISOString().slice(0, 10), recurrence: { kind: "daily" } }, "ms1");
      assert.ok(made.ok, JSON.stringify(made));
      stopped.add(`agent:${ids.cat}`);
      now = slot;
      for (let i = 0; i < 2; i++) await c.dispatch!.dispatcher.tick();
      const occurrenceId = (await call("meeting.schedule-get", { scheduleId: made.result.id })).result.item.lastOccurrenceId;
      const opened = await call("meeting.attend.open-room", { occurrenceId }, "or1"); assert.ok(opened.ok, JSON.stringify(opened));
      return { c, call, occurrenceId, ids, stopped, close: async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
    } catch (e) { await c.close(); throw e; }
}

test("a host that fails or times out on a wake reaches the owner as a fixed 'unavailable' message without the host's text, and the seat stays unwoken (card M04f)", async () => {
  for (const mode of ["fail", "hang", "timeout-text"] as const) {
    const f = await wakeFixture({ timeoutMs: 30, recover: async () => { if (mode === "fail") throw new Error("ssh root@10.0.0.7 /secret refused"); if (mode === "timeout-text") throw new Error("timed out"); await new Promise(() => undefined); } });
    try {
      const r = await f.call("meeting.attend.wake", { occurrenceId: f.occurrenceId, agent: `agent:${f.ids["cat"]}` }, "wkf");
      assert.equal(r.ok, false);
      assert.equal((r.error as unknown as { code: string }).code, "unavailable");
      assert.match(r.error!.message, new RegExp(`^the host did not wake agent:${f.ids["cat"]}${mode === "hang" ? ": it did not answer in time" : "$"}`));
      assert.doesNotMatch(r.error!.message, /10\.0\.0\.7|secret|request could not be completed/);
    } finally { await f.close(); }
  }
});

test("two wakes of the same agent in one meeting reach the host with two keys, and a replay of one wake command repeats its key (card M04f)", async () => {
  const keys: string[] = [];
  const f = await wakeFixture({ recover: async (r) => { keys.push(r.key); } });
  try {
    const agent = `agent:${f.ids["cat"]}`;
    const w1 = await f.call("meeting.attend.wake", { occurrenceId: f.occurrenceId, agent }, "wk-a"); assert.ok(w1.ok, JSON.stringify(w1));
    // The agent crashed again while the meeting was still open: the lifecycle still reports it stopped, and the owner wakes it again.
    const w2 = await f.call("meeting.attend.wake", { occurrenceId: f.occurrenceId, agent }, "wk-b"); assert.ok(w2.ok, JSON.stringify(w2));
    assert.deepEqual(keys, [`${f.occurrenceId}:${agent}:1`, `${f.occurrenceId}:${agent}:2`]);
    // The same command again is the same wake, never a third one.
    const again = await f.call("meeting.attend.wake", { occurrenceId: f.occurrenceId, agent }, "wk-b"); assert.ok(again.ok, JSON.stringify(again));
    assert.deepEqual(keys.slice(0, 2), [`${f.occurrenceId}:${agent}:1`, `${f.occurrenceId}:${agent}:2`]);
    assert.ok(keys.slice(2).every((k) => k === keys[1]), JSON.stringify(keys));
    // A different command is a third wake.
    assert.ok((await f.call("meeting.attend.wake", { occurrenceId: f.occurrenceId, agent }, "wk-c")).ok);
    assert.equal(keys.at(-1), `${f.occurrenceId}:${agent}:3`);
  } finally { await f.close(); }
});

test("a bad meetingWake.timeoutMs fails the controller start instead of turning the dispatcher off (card M04f)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-meet-"));
  try {
    await assert.rejects(startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], meetingWake: { recover: async () => undefined, timeoutMs: 0 } } as never), /meeting wake timeout/);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
